import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyPrintLine } from "./map.ts";

const SAMPLE = `
{"type":"event","event":{"type":"tool_running","toolCallId":"t1","toolName":"read_file","description":"reading main.ts"}}
{"type":"result","subtype":"success","sessionId":"9f4e1c0a-abcd","stopReason":"end_turn","usage":{"totalTokens":1200,"contextWindow":200000},"durationMs":8421,"finalText":"Done!\\n"}
`.trim();

describe("classifyPrintLine", () => {
  it("parses event frames and result line from the NDJSON stream", () => {
    const lines = SAMPLE.split("\n")
      .map((line) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          return null;
        }
        return classifyPrintLine(parsed);
      })
      .filter(Boolean);

    assert.equal(lines.length, 2);
    assert.equal(lines[0]?.kind, "event");
    assert.equal(lines[1]?.kind, "result");
    if (lines[1]?.kind === "result") {
      assert.equal(lines[1].result.sessionId, "9f4e1c0a-abcd");
      assert.equal(lines[1].result.subtype, "success");
      assert.equal(lines[1].result.finalText, "Done!\n");
      assert.equal(lines[1].result.stopReason, "end_turn");
    }
  });

  it("returns null for empty/invalid lines", () => {
    assert.equal(classifyPrintLine(""), null);
    assert.equal(classifyPrintLine("not-json"), null);
    assert.equal(classifyPrintLine(null), null);
  });
});
