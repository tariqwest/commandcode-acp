import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyConfigOptionValue,
  availableEffortsForModel,
  buildSessionConfigOptions,
} from "./config-options.ts";

describe("buildSessionConfigOptions", () => {
  it("builds model, effort, and permission_mode options", () => {
    const options = buildSessionConfigOptions({
      availableModels: ["claude-sonnet-5", "gpt-5.6-sol", "google/gemini-3.6-flash"],
      state: { modelId: "claude-sonnet-5", effort: "high", permissionMode: "standard" },
    });
    const ids = options.map((o) => o.id);
    assert.deepEqual(ids, ["model", "effort", "permission_mode"]);
    const model = options.find((o) => o.id === "model");
    assert.equal(model?.type, "select");
    if (model?.type === "select") {
      assert.equal(model.currentValue, "claude-sonnet-5");
      assert.equal(model.options.length, 3);
    }
    const effort = options.find((o) => o.id === "effort");
    if (effort?.type === "select") {
      assert.equal(effort.currentValue, "high");
    }
    const pm = options.find((o) => o.id === "permission_mode");
    if (pm?.type === "select") {
      assert.equal(pm.currentValue, "standard");
      assert.deepEqual(
        pm.options.map((o) => o.value),
        ["standard", "plan", "auto-accept"],
      );
    }
  });

  it("omits effort for models that decide their own depth", () => {
    const options = buildSessionConfigOptions({
      availableModels: ["moonshotai/Kimi-K3"],
      state: { modelId: "moonshotai/Kimi-K3", effort: null, permissionMode: "standard" },
    });
    const ids = options.map((o) => o.id);
    assert.ok(!ids.includes("effort"));
    assert.ok(ids.includes("permission_mode"));
  });

  it("returns empty model options when none available", () => {
    const options = buildSessionConfigOptions({
      availableModels: [],
      state: { modelId: null, effort: null, permissionMode: null },
    });
    const model = options.find((o) => o.id === "model");
    if (model?.type === "select") {
      assert.equal(model.currentValue, "");
      assert.equal(model.options.length, 0);
    }
  });
});

describe("availableEffortsForModel", () => {
  it("uses the per-model catalog map", () => {
    assert.deepEqual(availableEffortsForModel("claude-sonnet-5", []), [
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("returns empty for models without a map entry", () => {
    assert.deepEqual(availableEffortsForModel("moonshotai/Kimi-K3", ["moonshotai/Kimi-K3"]), []);
  });
});

describe("applyConfigOptionValue", () => {
  const base = {
    availableModels: ["claude-sonnet-5", "gpt-5.6-sol"],
    state: {
      modelId: "claude-sonnet-5",
      effort: "high" as const,
      permissionMode: "standard" as const,
    },
  };

  it("sets model and resets incompatible effort", () => {
    const next = applyConfigOptionValue({
      ...base,
      configId: "model",
      value: "gpt-5.6-sol",
    });
    assert.equal(next.modelId, "gpt-5.6-sol");
    // gpt-5.6-sol supports high, so effort is kept.
    assert.equal(next.effort, "high");
  });

  it("sets effort and validates availability", () => {
    const next = applyConfigOptionValue({
      ...base,
      configId: "effort",
      value: "max",
    });
    assert.equal(next.effort, "max");
  });

  it("rejects unavailable effort", () => {
    assert.throws(
      () =>
        applyConfigOptionValue({
          ...base,
          configId: "effort",
          value: "low",
          state: { ...base.state, modelId: "deepseek/deepseek-v4-pro" },
        }),
      /not available/,
    );
  });

  it("sets permission mode", () => {
    const next = applyConfigOptionValue({
      ...base,
      configId: "permission_mode",
      value: "auto-accept",
    });
    assert.equal(next.permissionMode, "auto-accept");
  });

  it("rejects invalid permission mode", () => {
    assert.throws(
      () =>
        applyConfigOptionValue({
          ...base,
          configId: "permission_mode",
          value: "yolo",
        }),
      /invalid permission_mode/,
    );
  });

  it("rejects unknown configId", () => {
    assert.throws(
      () => applyConfigOptionValue({ ...base, configId: "nope", value: "x" }),
      /unknown configId/,
    );
  });
});
