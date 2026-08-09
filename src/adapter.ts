import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import type * as acp from "@agentclientprotocol/sdk";
import {
  applyConfigOptionValue,
  buildSessionConfigOptions,
  MODEL_CONFIG_ID,
} from "./config-options.ts";
import {
  decideStopReason,
  deriveSessionTitle,
  flattenPromptText,
  mapEventFrameToUpdate,
  mapPrintResultToUpdates,
  type AcpSessionUpdate,
} from "./map.ts";
import {
  CmdCliError,
  cmdModelList,
  cmdPrintRun,
  cmdWhoami,
} from "./cmd.ts";
import { SessionStore, sessionFromStored } from "./session-store.ts";
import type { Session } from "./types.ts";

const require = createRequire(import.meta.url);
const PACKAGE_VERSION: string =
  (require("../package.json") as { version?: string }).version ?? "0.0.0";
const MAX_SESSIONS = 64;

type AgentContext = {
  notify: (method: string, params: unknown) => Promise<void> | void;
  signal?: AbortSignal;
};

function cwdFromParams(params: { cwd?: string } | undefined, fallback: string): string {
  const cwd = params?.cwd?.trim();
  return cwd && cwd.length > 0 ? cwd : fallback;
}

export type CommandCodeAcpAgentDeps = {
  store?: SessionStore;
  defaultCwd?: string;
  cmdModelListFn?: typeof cmdModelList;
  cmdWhoamiFn?: typeof cmdWhoami;
  cmdPrintRunFn?: typeof cmdPrintRun;
};

export class CommandCodeAcpAgent {
  private readonly sessions = new Map<string, Session>();
  private readonly store: SessionStore;
  private readonly defaultCwd: string;
  private readonly cmdModelListFn: typeof cmdModelList;
  private readonly cmdWhoamiFn: typeof cmdWhoami;
  private readonly cmdPrintRunFn: typeof cmdPrintRun;
  private availableModels: string[] = [];
  private modelsLoaded = false;
  private modelsInflight: Promise<void> | null = null;

  constructor(opts: CommandCodeAcpAgentDeps = {}) {
    this.store = opts.store ?? new SessionStore();
    this.defaultCwd =
      opts.defaultCwd ?? process.cwd() ?? process.env.HOME ?? "/tmp";
    this.cmdModelListFn = opts.cmdModelListFn ?? cmdModelList;
    this.cmdWhoamiFn = opts.cmdWhoamiFn ?? cmdWhoami;
    this.cmdPrintRunFn = opts.cmdPrintRunFn ?? cmdPrintRun;
  }

  async initModels(): Promise<void> {
    if (this.modelsInflight) {
      await this.modelsInflight;
      return;
    }
    this.modelsInflight = (async () => {
      try {
        const models = await this.cmdModelListFn();
        this.availableModels = models;
        if (models.length) {
          await this.store.saveModelsCache(models);
          this.modelsLoaded = true;
          console.error(
            `[commandcode-acp] fetched ${models.length} models from cmd --list-models`,
          );
          return;
        }
      } catch (err) {
        console.error(
          "[commandcode-acp] cmd --list-models failed:",
          (err as Error).message,
        );
      }
      const cached = await this.store.loadModelsCache();
      if (cached?.length) {
        this.availableModels = cached;
        this.modelsLoaded = true;
        console.error(
          `[commandcode-acp] using cached model list (${cached.length})`,
        );
        return;
      }
      // Fall back to the known catalog so pickers still render (best-effort).
      this.availableModels = [
        "claude-sonnet-5",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "google/gemini-3.6-flash",
        "deepseek/deepseek-v4-pro",
        "Qwen/Qwen3.8-Max",
      ];
      this.modelsLoaded = true;
      console.error(
        "[commandcode-acp] no models available; using built-in fallback list",
      );
    })().finally(() => {
      this.modelsInflight = null;
    });
    return this.modelsInflight;
  }

  private async ensureModels(): Promise<string[]> {
    if (!this.modelsLoaded) await this.initModels();
    return this.availableModels;
  }

  private sessionConfigOptionsJson(session: Session) {
    return buildSessionConfigOptions({
      availableModels: this.availableModels,
      state: {
        modelId: session.modelId,
        effort: session.effort,
        permissionMode: session.permissionMode,
      },
    });
  }

  private sessionModelsJson(session: Session) {
    const models = this.availableModels.length ? this.availableModels : [];
    const current = session.modelId || models[0] || "";
    return {
      currentModelId: current,
      availableModels: models.map((modelId) => ({ modelId, name: modelId })),
    };
  }

  private sessionConfigResult(sessionId: string, session: Session) {
    return {
      sessionId,
      models: this.sessionModelsJson(session),
      configOptions: this.sessionConfigOptionsJson(session),
    };
  }

  private emptySession(cwd: string): Session {
    return {
      cmdSessionId: null,
      modelId: this.availableModels[0] ?? null,
      effort: null,
      permissionMode: null,
      cwd,
      seenKeys: new Set(),
      title: null,
      updatedAt: new Date().toISOString(),
      activeAbort: null,
    };
  }

  private touch(session: Session) {
    session.updatedAt = new Date().toISOString();
  }

  private evictIfNeeded() {
    while (this.sessions.size >= MAX_SESSIONS) {
      const first = this.sessions.keys().next().value;
      if (!first) break;
      this.sessions.delete(first);
    }
  }

  private async restoreSession(sessionId: string): Promise<Session | null> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const stored = await this.store.get(sessionId);
    if (!stored) return null;
    const session = sessionFromStored(stored, this.defaultCwd);
    this.evictIfNeeded();
    this.sessions.set(sessionId, session);
    return session;
  }

  private async persist(sessionId: string, session: Session) {
    this.touch(session);
    await this.store.save(sessionId, session);
  }

  private async emitConfigOptionUpdate(sessionId: string, session: Session, cx?: AgentContext) {
    if (!cx) return;
    await cx.notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "config_option_update",
        configOptions: this.sessionConfigOptionsJson(session),
      },
    });
  }

  private async emitSessionInfo(sessionId: string, session: Session, cx?: AgentContext) {
    if (!cx || !session.title) return;
    await cx.notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "session_info_update",
        title: session.title,
        updatedAt: session.updatedAt,
      },
    });
  }

  async initialize(_params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    await this.ensureModels();
    try {
      const who = await this.cmdWhoamiFn();
      if (who.email || who.display_name || who.name || who.uid) {
        console.error(
          `[commandcode-acp] authenticated as ${who.display_name || who.name || who.email || who.uid}`,
        );
      }
    } catch (err) {
      console.error(
        "[commandcode-acp] WARN: cmd whoami failed — run `cmd login` first:",
        (err as Error).message,
      );
    }

    return {
      protocolVersion: 1,
      agentInfo: {
        name: "cmd",
        title: "Command Code",
        version: PACKAGE_VERSION,
      },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          // Baseline: text + resource_link. embeddedContext allows resource inlining.
          image: false,
          audio: false,
          embeddedContext: true,
        },
        // Command Code manages its own MCP servers; host mcpServers are ignored.
        mcpCapabilities: {
          http: false,
          sse: false,
        },
        sessionCapabilities: {
          resume: {},
          list: {},
          delete: {},
          close: {},
        },
      } as acp.AgentCapabilities,
      authMethods: [],
    };
  }

  async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    await this.ensureModels();
    const sessionId = randomUUID();
    const session = this.emptySession(cwdFromParams(params, this.defaultCwd));
    this.evictIfNeeded();
    this.sessions.set(sessionId, session);
    await this.persist(sessionId, session);
    return this.sessionConfigResult(sessionId, session) as acp.NewSessionResponse;
  }

  async loadSession(
    params: acp.LoadSessionRequest,
    cx?: AgentContext,
  ): Promise<acp.LoadSessionResponse> {
    await this.ensureModels();
    const sessionId = params.sessionId;
    if (!sessionId) {
      throw Object.assign(new Error("missing sessionId"), { code: -32602 });
    }

    const session = await this.restoreSession(sessionId);
    if (!session) {
      throw Object.assign(new Error(`unknown sessionId: ${sessionId}`), {
        code: -32000,
      });
    }
    if (params.cwd?.trim()) session.cwd = params.cwd.trim();

    // Replay prior turns best-effort via the cmd transcript (resume + marker prompt).
    if (session.cmdSessionId && cx) {
      try {
        await this.cmdPrintRunFn({
          prompt: "",
          cwd: session.cwd,
          cmdSessionId: session.cmdSessionId,
          modelId: session.modelId,
          effort: session.effort,
          permissionMode: session.permissionMode,
          signal: cx.signal,
          onLine: async (line) => {
            if (line.kind === "event") {
              const update = mapEventFrameToUpdate(line.frame.event);
              if (update) {
                await cx.notify("session/update", { sessionId, update });
              }
            } else if (line.kind === "result") {
              const messageId = `cmd-replay-${session.cmdSessionId ?? sessionId}`;
              const deltas = mapPrintResultToUpdates(line.result, messageId, new Set());
              for (const delta of deltas) {
                await cx.notify("session/update", { sessionId, update: delta.update });
              }
            }
          },
        });
      } catch (err) {
        console.error(
          "[commandcode-acp] WARN: failed to replay conversation:",
          (err as Error).message,
        );
      }
    }

    await this.emitConfigOptionUpdate(sessionId, session, cx);
    await this.emitSessionInfo(sessionId, session, cx);
    await this.persist(sessionId, session);
    return this.sessionConfigResult(sessionId, session) as acp.LoadSessionResponse;
  }

  async resumeSession(params: acp.ResumeSessionRequest): Promise<acp.ResumeSessionResponse> {
    await this.ensureModels();
    const sessionId = params.sessionId;
    if (!sessionId) {
      throw Object.assign(new Error("missing sessionId"), { code: -32602 });
    }
    const session = await this.restoreSession(sessionId);
    if (!session) {
      throw Object.assign(new Error(`unknown sessionId: ${sessionId}`), {
        code: -32000,
      });
    }
    if (params.cwd?.trim()) session.cwd = params.cwd.trim();
    await this.emitConfigOptionUpdate(sessionId, session);
    await this.persist(sessionId, session);
    return this.sessionConfigResult(sessionId, session) as acp.ResumeSessionResponse;
  }

  async listSessions(
    _params: acp.ListSessionsRequest = {},
  ): Promise<acp.ListSessionsResponse> {
    const listed = await this.store.list();
    return {
      sessions: listed.map((s) => ({
        sessionId: s.sessionId,
        cwd: s.cwd,
        title: s.title ?? undefined,
        updatedAt: s.updatedAt ?? undefined,
        _meta: {
          cmdSessionId: s.cmdSessionId,
          modelId: s.modelId,
          effort: s.effort,
          permissionMode: s.permissionMode,
        },
      })),
    } as acp.ListSessionsResponse;
  }

  async deleteSession(params: { sessionId: string }): Promise<Record<string, never>> {
    const sessionId = params.sessionId;
    if (!sessionId) {
      throw Object.assign(new Error("missing sessionId"), { code: -32602 });
    }
    const session = this.sessions.get(sessionId);
    session?.activeAbort?.abort();
    this.sessions.delete(sessionId);
    await this.store.delete(sessionId);
    return {};
  }

  async closeSession(params: { sessionId: string }): Promise<Record<string, never>> {
    const sessionId = params.sessionId;
    if (!sessionId) {
      throw Object.assign(new Error("missing sessionId"), { code: -32602 });
    }
    const session = this.sessions.get(sessionId);
    if (session) {
      session.activeAbort?.abort();
      try {
        await this.persist(sessionId, session);
      } catch {
        // best-effort
      }
      this.sessions.delete(sessionId);
    }
    return {};
  }

  async setSessionModel(params: {
    sessionId: string;
    modelId: string;
  }): Promise<Record<string, never>> {
    const { sessionId, modelId } = params;
    if (!sessionId || !modelId) {
      throw Object.assign(new Error("missing sessionId or modelId"), {
        code: -32602,
      });
    }
    await this.ensureModels();
    const session = await this.restoreSession(sessionId);
    if (!session) {
      throw Object.assign(new Error(`unknown sessionId: ${sessionId}`), {
        code: -32000,
      });
    }
    const next = applyConfigOptionValue({
      configId: MODEL_CONFIG_ID,
      value: modelId,
      state: {
        modelId: session.modelId,
        effort: session.effort,
        permissionMode: session.permissionMode,
      },
      availableModels: this.availableModels,
    });
    session.modelId = next.modelId;
    session.effort = next.effort ?? null;
    await this.persist(sessionId, session);
    return {};
  }

  async setSessionConfigOption(
    params: acp.SetSessionConfigOptionRequest,
  ): Promise<acp.SetSessionConfigOptionResponse> {
    const sessionId = params.sessionId;
    const configId = params.configId;
    const value = params.value as unknown;
    if (!sessionId || !configId || value === undefined || value === null || value === "") {
      throw Object.assign(new Error("missing sessionId, configId, or value"), {
        code: -32602,
      });
    }
    await this.ensureModels();
    const session = await this.restoreSession(sessionId);
    if (!session) {
      throw Object.assign(new Error(`unknown sessionId: ${sessionId}`), {
        code: -32000,
      });
    }

    let next;
    try {
      next = applyConfigOptionValue({
        configId,
        value,
        state: {
          modelId: session.modelId,
          effort: session.effort,
          permissionMode: session.permissionMode,
        },
        availableModels: this.availableModels,
      });
    } catch (err) {
      throw Object.assign(new Error((err as Error).message), {
        code: (err as { code?: number }).code ?? -32602,
      });
    }

    session.modelId = next.modelId;
    session.effort = next.effort ?? null;
    session.permissionMode = next.permissionMode ?? null;
    await this.persist(sessionId, session);
    return {
      configOptions: this.sessionConfigOptionsJson(session),
    } as acp.SetSessionConfigOptionResponse;
  }

  cancel(params: { sessionId: string }) {
    const session = this.sessions.get(params.sessionId);
    session?.activeAbort?.abort();
  }

  async prompt(
    params: acp.PromptRequest,
    cx: AgentContext,
  ): Promise<acp.PromptResponse> {
    await this.ensureModels();
    const sessionId = params.sessionId;
    if (!sessionId) {
      throw Object.assign(new Error("missing sessionId"), { code: -32602 });
    }

    let session = await this.restoreSession(sessionId);
    if (!session) {
      // Allow hosts that skip explicit new/load in tests: create ephemeral binding.
      session = this.emptySession(this.defaultCwd);
      this.sessions.set(sessionId, session);
    }

    const promptText = flattenPromptText(params.prompt);
    if (!promptText) {
      throw Object.assign(new Error("empty prompt"), { code: -32602 });
    }

    const abort = new AbortController();
    session.activeAbort = abort;
    const onCxAbort = () => abort.abort();
    cx.signal?.addEventListener("abort", onCxAbort, { once: true });

    const emit = async (update: AcpSessionUpdate) => {
      await cx.notify("session/update", { sessionId, update });
    };

    const messageId = `cmd-${sessionId}-${Date.now()}`;
    let hadUpdates = false;

    try {
      // Derive a title from the first prompt so hosts can show a session name.
      if (!session.title) {
        session.title = deriveSessionTitle(promptText);
        await this.emitSessionInfo(sessionId, session, cx);
      }

      await emit({
        sessionUpdate: "user_message_chunk",
        messageId: `cmd-user-${sessionId}-${Date.now()}`,
        content: { type: "text", text: promptText },
      });

      let run;
      try {
        run = await this.cmdPrintRunFn({
          prompt: promptText,
          cwd: session.cwd,
          cmdSessionId: session.cmdSessionId,
          modelId: session.modelId,
          effort: session.effort,
          permissionMode: session.permissionMode,
          signal: abort.signal,
          onLine: async (line) => {
            if (line.kind === "event") {
              const update = mapEventFrameToUpdate(line.frame.event);
              if (!update) return;
              const key = `live:${JSON.stringify(update)}`;
              if (session.seenKeys.has(key)) return;
              session.seenKeys.add(key);
              hadUpdates = true;
              await emit(update);
              return;
            }
            if (line.kind === "result") {
              if (line.result.sessionId) {
                session.cmdSessionId = line.result.sessionId;
              }
              const deltas = mapPrintResultToUpdates(
                line.result,
                messageId,
                session.seenKeys,
              );
              for (const delta of deltas) {
                session.seenKeys.add(delta.key);
                hadUpdates = true;
                await emit(delta.update);
              }
            }
          },
        });
      } catch (err) {
        if (abort.signal.aborted) {
          return { stopReason: "cancelled" };
        }
        const message =
          err instanceof CmdCliError
            ? err.message
            : `failed to run cmd: ${(err as Error).message}`;
        throw Object.assign(new Error(message), { code: -32000 });
      }

      // cmdPrintRun already emitted live updates during the run. Fall back to
      // streaming finalText if the live stream carried nothing (older/quiet runs).
      const finalText =
        run.result && typeof run.result.finalText === "string"
          ? run.result.finalText.trim()
          : "";
      if (finalText && !hadUpdates) {
        const update: AcpSessionUpdate = {
          sessionUpdate: "agent_message_chunk",
          messageId,
          content: { type: "text", text: finalText },
        };
        const key = `final:${messageId}:${finalText}`;
        if (!session.seenKeys.has(key)) {
          session.seenKeys.add(key);
          hadUpdates = true;
          await emit(update);
        }
      }

      await this.persist(sessionId, session);

      const decision = decideStopReason({
        cancelled: abort.signal.aborted,
        result: run.result,
        exitCode: run.exitCode,
        hadUpdates,
      });

      if (decision.error) {
        throw Object.assign(new Error(decision.error), { code: -32000 });
      }
      return { stopReason: decision.stopReason ?? "end_turn" };
    } finally {
      cx.signal?.removeEventListener("abort", onCxAbort);
      if (session.activeAbort === abort) session.activeAbort = null;
    }
  }
}
