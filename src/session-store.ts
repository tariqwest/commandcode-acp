import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  SessionStoreSchema,
  type Session,
  type SessionStoreFile,
  type StoredSession,
} from "./types.ts";

export type SessionStorePaths = {
  stateDir: string;
  stateFile: string;
  lockFile: string;
  modelsCacheFile: string;
};

export function defaultStorePaths(
  env: NodeJS.ProcessEnv = process.env,
  home = env.HOME || os.homedir(),
): SessionStorePaths {
  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim();
  const stateDir = xdgConfigHome
    ? path.join(xdgConfigHome, "commandcode-acp")
    : path.join(home, ".config", "commandcode-acp");
  return {
    stateDir,
    stateFile: path.join(stateDir, "sessions.json"),
    lockFile: path.join(stateDir, "sessions.lock"),
    modelsCacheFile: path.join(stateDir, "models_cache.json"),
  };
}

async function ensureDir(dir: string) {
  await fsp.mkdir(dir, { recursive: true });
}

async function withExclusiveLock<T>(
  lockFile: string,
  fn: () => Promise<T>,
): Promise<T> {
  await ensureDir(path.dirname(lockFile));
  // Portable exclusive lock via O_EXCL create (works without FileHandle.lock).
  const start = Date.now();
  const timeoutMs = 10_000;
  let handle: fsp.FileHandle | null = null;
  while (!handle) {
    try {
      handle = await fsp.open(lockFile, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (Date.now() - start > timeoutMs) {
        throw new Error(`timed out waiting for session store lock: ${lockFile}`);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  try {
    return await fn();
  } finally {
    await handle.close().catch(() => undefined);
    await fsp.unlink(lockFile).catch(() => undefined);
  }
}

function storedFromSession(session: Session): StoredSession {
  return {
    cmdSessionId: session.cmdSessionId,
    modelId: session.modelId,
    effort: session.effort,
    permissionMode: session.permissionMode,
    cwd: session.cwd,
    seenKeys: [...session.seenKeys],
    title: session.title,
    updatedAt: session.updatedAt,
  };
}

export function sessionFromStored(
  stored: StoredSession,
  fallbackCwd: string,
): Session {
  return {
    cmdSessionId: stored.cmdSessionId ?? null,
    modelId: stored.modelId ?? null,
    effort: stored.effort ?? null,
    permissionMode: stored.permissionMode ?? null,
    cwd: stored.cwd || fallbackCwd,
    seenKeys: new Set(stored.seenKeys ?? []),
    title: stored.title ?? null,
    updatedAt: stored.updatedAt ?? new Date().toISOString(),
    activeAbort: null,
  };
}

export class SessionStore {
  readonly paths: SessionStorePaths;

  constructor(paths: SessionStorePaths = defaultStorePaths()) {
    this.paths = paths;
  }

  async load(): Promise<SessionStoreFile> {
    return withExclusiveLock(this.paths.lockFile, async () => this.loadUnlocked());
  }

  private async loadUnlocked(): Promise<SessionStoreFile> {
    try {
      const raw = await fsp.readFile(this.paths.stateFile, "utf8");
      const parsed = SessionStoreSchema.parse(JSON.parse(raw));
      if (!parsed.sessions) return { sessions: {} };
      return parsed;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { sessions: {} };
      }
      console.error("[commandcode-acp] WARN: failed to load session store:", err);
      return { sessions: {} };
    }
  }

  async get(sessionId: string): Promise<StoredSession | null> {
    const store = await this.load();
    return store.sessions?.[sessionId] ?? null;
  }

  async list(): Promise<Array<{ sessionId: string } & StoredSession>> {
    const store = await this.load();
    return Object.entries(store.sessions ?? {}).map(([sessionId, stored]) => ({
      sessionId,
      ...stored,
    }));
  }

  async save(sessionId: string, session: Session): Promise<void> {
    await withExclusiveLock(this.paths.lockFile, async () => {
      const store = await this.loadUnlocked();
      if (!store.sessions) store.sessions = {};
      store.sessions[sessionId] = storedFromSession(session);
      await this.writeUnlocked(store);
    });
  }

  async delete(sessionId: string): Promise<void> {
    await withExclusiveLock(this.paths.lockFile, async () => {
      const store = await this.loadUnlocked();
      if (!store.sessions) store.sessions = {};
      delete store.sessions[sessionId];
      await this.writeUnlocked(store);
    });
  }

  private async writeUnlocked(store: SessionStoreFile): Promise<void> {
    await ensureDir(this.paths.stateDir);
    const tmp = `${this.paths.stateFile}.${process.pid}.tmp`;
    const json = JSON.stringify(store, null, 2);
    await fsp.writeFile(tmp, json, "utf8");
    await fsp.rename(tmp, this.paths.stateFile);
  }

  async loadModelsCache(): Promise<string[] | null> {
    try {
      const raw = await fsp.readFile(this.paths.modelsCacheFile, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string") && parsed.length) {
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  }

  async saveModelsCache(models: string[]): Promise<void> {
    await ensureDir(this.paths.stateDir);
    const tmp = `${this.paths.modelsCacheFile}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(models, null, 2), "utf8");
    await fsp.rename(tmp, this.paths.modelsCacheFile);
  }
}

/** Sync helpers used only in tests / rare startup paths. */
export function readStoreSync(stateFile: string): SessionStoreFile {
  try {
    const parsed = SessionStoreSchema.parse(JSON.parse(fs.readFileSync(stateFile, "utf8")));
    if (!parsed.sessions) return { sessions: {} };
    return parsed;
  } catch {
    return { sessions: {} };
  }
}
