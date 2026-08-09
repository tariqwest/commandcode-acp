import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  SessionStore,
  defaultStorePaths,
  readStoreSync,
  sessionFromStored,
} from "./session-store.ts";

function tempPaths(): ReturnType<typeof defaultStorePaths> {
  const dir = path.join(
    os.tmpdir(),
    `commandcode-acp-test-${process.pid}-${Date.now()}`,
  );
  return {
    stateDir: dir,
    stateFile: path.join(dir, "sessions.json"),
    lockFile: path.join(dir, "sessions.lock"),
    modelsCacheFile: path.join(dir, "models_cache.json"),
  };
}

describe("SessionStore", () => {
  it("round-trips a session save/get", async () => {
    const store = new SessionStore(tempPaths());
    const session = sessionFromStored(
      {
        cmdSessionId: "cmd-1",
        modelId: "claude-sonnet-5",
        effort: "high",
        permissionMode: "auto-accept",
        cwd: "/tmp",
        seenKeys: ["a", "b"],
        title: "My session",
      },
      "/fallback",
    );
    await store.save("acp-1", session);

    const got = await store.get("acp-1");
    assert.equal(got?.cmdSessionId, "cmd-1");
    assert.equal(got?.modelId, "claude-sonnet-5");
    assert.equal(got?.effort, "high");
    assert.equal(got?.permissionMode, "auto-accept");
    assert.deepEqual(got?.seenKeys, ["a", "b"]);
    assert.equal(got?.title, "My session");

    const listed = await store.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.sessionId, "acp-1");
  });

  it("deletes a session", async () => {
    const store = new SessionStore(tempPaths());
    await store.save(
      "acp-1",
      sessionFromStored({ seenKeys: [], cwd: "/tmp" }, "/"),
    );
    await store.delete("acp-1");
    assert.equal(await store.get("acp-1"), null);
  });

  it("returns null for missing sessions", async () => {
    const store = new SessionStore(tempPaths());
    assert.equal(await store.get("nope"), null);
  });

  it("persists models cache", async () => {
    const store = new SessionStore(tempPaths());
    await store.saveModelsCache(["claude-sonnet-5", "gpt-5.6-sol"]);
    assert.deepEqual(await store.loadModelsCache(), ["claude-sonnet-5", "gpt-5.6-sol"]);
  });

  it("handles concurrent saves without corruption", async () => {
    const store = new SessionStore(tempPaths());
    await Promise.all([
      store.save("a", sessionFromStored({ seenKeys: [], cmdSessionId: "x" }, "/")),
      store.save("b", sessionFromStored({ seenKeys: [], cmdSessionId: "y" }, "/")),
    ]);
    const listed = await store.list();
    assert.equal(listed.length, 2);
    const file = readStoreSync(store.paths.stateFile);
    assert.equal(Object.keys(file.sessions ?? {}).length, 2);
  });

  it("readStoreSync returns empty store for missing file", () => {
    const store = new SessionStore(tempPaths());
    assert.deepEqual(readStoreSync(store.paths.stateFile), { sessions: {} });
  });

  it("loads an existing file", async () => {
    const store = new SessionStore(tempPaths());
    await store.save(
      "acp-1",
      sessionFromStored({ seenKeys: [], cmdSessionId: "cmd-9" }, "/"),
    );
    const raw = await fsp.readFile(store.paths.stateFile, "utf8");
    assert.ok(raw.includes('"cmdSessionId"'));
  });
});
