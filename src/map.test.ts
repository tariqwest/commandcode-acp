import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyPrintLine,
  decideStopReason,
  deriveSessionTitle,
  flattenPromptText,
  mapEventFrameToUpdate,
  mapPrintResultToUpdates,
  toolKindFromName,
  usageUpdateFromResult,
} from "./map.ts";
import { split } from "./shell-words.ts";
import type { PrintResult } from "./types.ts";

describe("flattenPromptText", () => {
  it("joins text blocks", () => {
    assert.equal(
      flattenPromptText([
        { type: "text", text: "hello" },
        { type: "text", text: "world" },
      ]),
      "hello\n\nworld",
    );
  });

  it("handles bare string", () => {
    assert.equal(flattenPromptText("hi"), "hi");
  });

  it("includes resource_link and embedded resource text", () => {
    const text = flattenPromptText([
      { type: "text", text: "Look at this:" },
      {
        type: "resource_link",
        name: "README",
        uri: "file:///tmp/README.md",
        mimeType: "text/markdown",
      },
      {
        type: "resource",
        resource: {
          uri: "file:///tmp/main.ts",
          mimeType: "text/typescript",
          text: "export const x = 1;",
        },
      },
    ]);
    assert.match(text, /Look at this:/);
    assert.match(text, /\[resource_link\] README \(text\/markdown\): file:\/\/\/tmp\/README\.md/);
    assert.match(text, /\[resource\] file:\/\/\/tmp\/main\.ts \(text\/typescript\)/);
    assert.match(text, /export const x = 1;/);
  });

  it("placeholders image blocks without dropping the rest", () => {
    const text = flattenPromptText([
      { type: "text", text: "see image" },
      { type: "image", mimeType: "image/png", data: "aaaa" },
    ]);
    assert.match(text, /see image/);
    assert.match(text, /\[image omitted/);
  });
});

describe("classifyPrintLine", () => {
  it("classifies a result line", () => {
    const line = classifyPrintLine({ type: "result", subtype: "success" });
    assert.equal(line?.kind, "result");
  });

  it("classifies an event frame", () => {
    const line = classifyPrintLine({
      type: "event",
      event: { type: "tool_running", toolCallId: "t1", toolName: "read_file" },
    });
    assert.equal(line?.kind, "event");
    if (line?.kind === "event") {
      assert.equal(line.frame.event.toolName, "read_file");
    }
  });

  it("returns other for unknown shapes", () => {
    assert.equal(classifyPrintLine(null), null);
    assert.equal(classifyPrintLine([1, 2]), null);
    assert.equal(classifyPrintLine({ foo: 1 })?.kind, "other");
  });
});

describe("mapEventFrameToUpdate", () => {
  it("maps tool_running to tool_call", () => {
    const update = mapEventFrameToUpdate({
      type: "tool_running",
      toolCallId: "t1",
      toolName: "run_command",
      description: "running ls",
    });
    assert.equal(update?.sessionUpdate, "tool_call");
    assert.equal(update?.toolCallId, "t1");
    assert.equal(update?.kind, "execute");
    assert.equal(update?.status, "in_progress");
  });

  it("ignores unknown event types", () => {
    assert.equal(mapEventFrameToUpdate({ type: "some_future_event" }), null);
  });
});

describe("mapPrintResultToUpdates", () => {
  it("maps finalText and usage to updates", () => {
    const result: PrintResult = {
      type: "result",
      subtype: "success",
      sessionId: "s1",
      stopReason: "end_turn",
      finalText: "Hello!",
      usage: { totalTokens: 100, contextWindow: 200000 },
      durationMs: 100,
    };
    const deltas = mapPrintResultToUpdates(result, "m1", new Set());
    const kinds = deltas.map((d) => d.update.sessionUpdate);
    assert.deepEqual(kinds, ["agent_message_chunk", "usage_update"]);
    assert.equal(deltas[0]!.update.messageId, "m1");
  });

  it("skips already-seen keys", () => {
    const result: PrintResult = {
      type: "result",
      subtype: "success",
      finalText: "dup",
    };
    const first = mapPrintResultToUpdates(result, "m1", new Set());
    const seen = new Set(first.map((d) => d.key));
    const second = mapPrintResultToUpdates(result, "m1", seen);
    assert.equal(second.length, 0);
  });

  it("returns empty for a result with no forwardable content", () => {
    const result: PrintResult = { type: "result", subtype: "success" };
    assert.equal(mapPrintResultToUpdates(result, "m1", new Set()).length, 0);
  });
});

describe("usageUpdateFromResult", () => {
  it("extracts used/size when present", () => {
    const u = usageUpdateFromResult({
      type: "result",
      subtype: "success",
      usage: { totalTokens: 1200, contextWindow: 200000 },
    });
    assert.deepEqual(u, {
      sessionUpdate: "usage_update",
      used: 1200,
      size: 200000,
    });
  });

  it("returns null without both sides", () => {
    const u = usageUpdateFromResult({
      type: "result",
      subtype: "success",
      usage: { totalTokens: 10 },
    });
    assert.equal(u, null);
  });
});

describe("decideStopReason", () => {
  it("returns cancelled when aborted", () => {
    assert.deepEqual(
      decideStopReason({ cancelled: true, result: null, exitCode: 0, hadUpdates: true }),
      { stopReason: "cancelled" },
    );
  });

  it("returns cancelled on exit 130", () => {
    assert.deepEqual(
      decideStopReason({ cancelled: false, result: null, exitCode: 130, hadUpdates: false }),
      { stopReason: "cancelled" },
    );
  });

  it("maps success result to end_turn", () => {
    assert.deepEqual(
      decideStopReason({
        cancelled: false,
        result: { type: "result", subtype: "success" },
        exitCode: 0,
        hadUpdates: true,
      }),
      { stopReason: "end_turn" },
    );
  });

  it("maps max_turns subtype to max_turn_requests", () => {
    assert.deepEqual(
      decideStopReason({
        cancelled: false,
        result: { type: "result", subtype: "max_turns" },
        exitCode: 8,
        hadUpdates: true,
      }),
      { stopReason: "max_turn_requests" },
    );
  });

  it("classifies refusal from error text", () => {
    assert.deepEqual(
      decideStopReason({
        cancelled: false,
        result: {
          type: "result",
          subtype: "error",
          error: "content policy refusal",
        },
        exitCode: 1,
        hadUpdates: false,
      }),
      { stopReason: "refusal" },
    );
  });

  it("classifies max_tokens from error text", () => {
    assert.deepEqual(
      decideStopReason({
        cancelled: false,
        result: {
          type: "result",
          subtype: "error",
          error: "exceeded maximum context length / token limit",
        },
        exitCode: 1,
        hadUpdates: false,
      }),
      { stopReason: "max_tokens" },
    );
  });

  it("errors on error result with no updates", () => {
    const r = decideStopReason({
      cancelled: false,
      result: { type: "result", subtype: "error", error: "boom" },
      exitCode: 1,
      hadUpdates: false,
    });
    assert.equal(r.stopReason, undefined);
    assert.match(r.error ?? "", /boom/);
  });

  it("returns end_turn when error result but had updates", () => {
    assert.deepEqual(
      decideStopReason({
        cancelled: false,
        result: { type: "result", subtype: "error", error: "boom" },
        exitCode: 1,
        hadUpdates: true,
      }),
      { stopReason: "end_turn" },
    );
  });

  it("maps exit 3 to auth error", () => {
    const r = decideStopReason({
      cancelled: false,
      result: null,
      exitCode: 3,
      hadUpdates: false,
    });
    assert.equal(r.stopReason, undefined);
    assert.match(r.error ?? "", /login/i);
  });

  it("maps exit 8 (no result) to max_turn_requests", () => {
    assert.deepEqual(
      decideStopReason({ cancelled: false, result: null, exitCode: 8, hadUpdates: true }),
      { stopReason: "max_turn_requests" },
    );
  });
});

describe("toolKindFromName", () => {
  it("classifies common tools", () => {
    assert.equal(toolKindFromName("write_file"), "edit");
    assert.equal(toolKindFromName("read_file"), "read");
    assert.equal(toolKindFromName("run_command"), "execute");
    assert.equal(toolKindFromName("bash"), "execute");
    assert.equal(toolKindFromName("grep_search"), "search");
    assert.equal(toolKindFromName("delete_file"), "delete");
    assert.equal(toolKindFromName("web_fetch"), "fetch");
    assert.equal(toolKindFromName("unknown_thing"), "other");
  });
});

describe("deriveSessionTitle", () => {
  it("derives a short title from the prompt", () => {
    assert.equal(deriveSessionTitle("fix the login bug"), "fix the login bug");
  });

  it("truncates long prompts", () => {
    const long = "x".repeat(100);
    const title = deriveSessionTitle(long);
    assert.ok(title.length <= 60);
  });
});

describe("shell-words split", () => {
  it("splits plain args", () => {
    assert.deepEqual(split("--foo bar"), ["--foo", "bar"]);
  });

  it("keeps quoted values", () => {
    assert.deepEqual(split(`--prompt "hello world"`), ["--prompt", "hello world"]);
  });
});
