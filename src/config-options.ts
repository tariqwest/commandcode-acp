/** ACP session config option helpers for commandcode-acp. */

import type { EffortLevel, PermissionMode } from "./types.ts";

export const MODEL_CONFIG_ID = "model";
export const EFFORT_CONFIG_ID = "effort";
export const PERMISSION_MODE_CONFIG_ID = "permission_mode";

export const EFFORT_LEVELS: EffortLevel[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const EFFORT_SET = new Set<string>(EFFORT_LEVELS);

/**
 * Effort levels supported per model family (from the Command Code model catalog).
 * Models absent from this map decide their own reasoning depth (no effort option).
 */
export const MODEL_EFFORTS: Record<string, EffortLevel[]> = {
  "claude-sonnet-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-sonnet-4-6": ["low", "medium", "high", "xhigh", "max"],
  "claude-fable-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-8": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-7": ["low", "medium", "high", "xhigh", "max"],
  "gpt-5.6-sol": ["low", "medium", "high", "xhigh", "max"],
  "gpt-5.6-terra": ["low", "medium", "high", "xhigh", "max"],
  "gpt-5.6-luna": ["low", "medium", "high", "xhigh", "max"],
  "gpt-5.5": ["low", "medium", "high", "xhigh"],
  "gpt-5.4": ["low", "medium", "high", "xhigh"],
  "gpt-5.3-codex": ["low", "medium", "high", "xhigh"],
  "gpt-5.4-mini": ["low", "medium", "high"],
  "google/gemini-3.6-flash": ["low", "medium", "high"],
  "google/gemini-3.5-flash": ["low", "medium", "high"],
  "google/gemini-3.5-flash-lite": ["low", "medium", "high"],
  "google/gemini-3.1-flash-lite": ["low", "medium", "high"],
  "xai/grok-4.5": ["low", "medium", "high"],
  "deepseek/deepseek-v4-pro": ["high", "max"],
  "deepseek/deepseek-v4-flash": ["high", "max"],
  "zai-org/GLM-5.2": ["high", "max"],
  "Qwen/Qwen3.8-Max": ["low", "medium", "xhigh"],
  "sakana/fugu-ultra": ["high", "xhigh"],
};

export const PERMISSION_MODES: PermissionMode[] = [
  "standard",
  "plan",
  "auto-accept",
];

export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  standard: "Standard",
  plan: "Plan (read-only)",
  "auto-accept": "Auto-accept",
};

export function isEffortLevel(value: string): value is EffortLevel {
  return EFFORT_SET.has(value);
}

export type SelectOption = { value: string; name: string };

export type SessionConfigOption =
  | {
      id: string;
      name: string;
      category: string;
      type: "select";
      currentValue: string;
      options: SelectOption[];
    }
  | {
      id: string;
      name: string;
      category: string;
      type: "boolean";
      currentValue: boolean;
    };

export type ConfigState = {
  modelId: string | null;
  effort: EffortLevel | null;
  permissionMode: PermissionMode | null;
};

export function effortLabel(effort: EffortLevel): string {
  switch (effort) {
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "high":
      return "High";
    case "xhigh":
      return "Extra high";
    case "max":
      return "Max";
    default:
      return effort;
  }
}

/** Effort levels available for a model id (empty = model decides its own depth). */
export function availableEffortsForModel(
  modelId: string,
  availableModels: string[],
): EffortLevel[] {
  const direct = MODEL_EFFORTS[modelId];
  if (direct) return direct;
  // Model absent from the map: no effort control unless the catalog maps by prefix.
  for (const id of availableModels) {
    if (id === modelId) continue;
    if (id.startsWith(`${modelId}-`)) {
      const suffix = id.slice(modelId.length + 1);
      if (isEffortLevel(suffix)) return [suffix];
    }
  }
  return [];
}

export function buildSessionConfigOptions(opts: {
  availableModels: string[];
  state: ConfigState;
}): SessionConfigOption[] {
  const models = opts.availableModels.length ? opts.availableModels : [];
  const currentModel = opts.state.modelId || models[0] || "";

  const options: SessionConfigOption[] = [
    {
      id: MODEL_CONFIG_ID,
      name: "Model",
      category: "model",
      type: "select",
      currentValue: currentModel,
      options: models.map((modelId) => ({ value: modelId, name: modelId })),
    },
  ];

  const efforts = currentModel ? availableEffortsForModel(currentModel, models) : [];
  if (efforts.length) {
    const currentEffort =
      opts.state.effort && efforts.includes(opts.state.effort)
        ? opts.state.effort
        : efforts.includes("medium")
          ? "medium"
          : efforts[0]!;
    options.push({
      id: EFFORT_CONFIG_ID,
      name: "Effort",
      category: "thought_level",
      type: "select",
      currentValue: currentEffort,
      options: efforts.map((e) => ({ value: e, name: effortLabel(e) })),
    });
  }

  options.push({
    id: PERMISSION_MODE_CONFIG_ID,
    name: "Permission mode",
    category: "mode",
    type: "select",
    currentValue: opts.state.permissionMode ?? "standard",
    options: PERMISSION_MODES.map((mode) => ({
      value: mode,
      name: PERMISSION_MODE_LABELS[mode],
    })),
  });

  return options;
}

export function applyConfigOptionValue(input: {
  configId: string;
  value: unknown;
  state: ConfigState;
  availableModels: string[];
}): ConfigState {
  const { configId, value, availableModels } = input;
  let { modelId, effort, permissionMode } = input.state;

  if (configId === MODEL_CONFIG_ID) {
    const next = String(value);
    if (!next) throw invalid("empty model value");
    if (availableModels.length && !availableModels.includes(next)) {
      throw invalid(`unknown model: ${next}`);
    }
    modelId = next;
    // Reset effort if the new model doesn't support the current one.
    if (effort && !availableEffortsForModel(next, availableModels).includes(effort)) {
      effort = null;
    }
    return { modelId, effort, permissionMode };
  }

  if (configId === EFFORT_CONFIG_ID) {
    const next = String(value);
    if (!isEffortLevel(next)) throw invalid(`invalid effort: ${next}`);
    const current = modelId || availableModels[0] || "";
    if (current) {
      const efforts = availableEffortsForModel(current, availableModels);
      if (!efforts.includes(next)) {
        throw invalid(`effort ${next} is not available for model ${current}`);
      }
    }
    effort = next;
    return { modelId, effort, permissionMode };
  }

  if (configId === PERMISSION_MODE_CONFIG_ID) {
    const next = String(value);
    if (!PERMISSION_MODES.includes(next as PermissionMode)) {
      throw invalid(`invalid permission_mode: ${next}`);
    }
    permissionMode = next as PermissionMode;
    return { modelId, effort, permissionMode };
  }

  throw invalid(`unknown configId: ${configId}`);
}

function invalid(message: string): Error {
  return Object.assign(new Error(message), { code: -32602 });
}
