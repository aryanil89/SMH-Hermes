import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { readState, writeState } from "./state-store.js";

let dir: string | undefined;

afterEach(async () => {
  if (dir) {
    await rm(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

describe("state-store", () => {
  it("returns a fresh ok baseline when the file does not exist", async () => {
    dir = await mkdtemp(join(tmpdir(), "smh-hermes-state-"));
    const state = await readState(join(dir, "nope", "state.json"));
    expect(state).toEqual({ lastStatus: "ok" });
  });

  it("round-trips a written state", async () => {
    dir = await mkdtemp(join(tmpdir(), "smh-hermes-state-"));
    const path = join(dir, "nested", "state.json");
    await writeState(path, { lastStatus: "warning", lastAlertedAt: "2026-08-03T12:00:00.000Z" });
    const state = await readState(path);
    expect(state).toEqual({ lastStatus: "warning", lastAlertedAt: "2026-08-03T12:00:00.000Z" });
  });

  it("treats a corrupt file as a fresh ok baseline instead of throwing", async () => {
    dir = await mkdtemp(join(tmpdir(), "smh-hermes-state-"));
    const path = join(dir, "state.json");
    await mkdir(dir, { recursive: true });
    await writeFile(path, "{ not valid json", "utf8");
    const state = await readState(path);
    expect(state).toEqual({ lastStatus: "ok" });
  });

  it("treats a file with an invalid status value as a fresh ok baseline", async () => {
    dir = await mkdtemp(join(tmpdir(), "smh-hermes-state-"));
    const path = join(dir, "state.json");
    await mkdir(dir, { recursive: true });
    await writeFile(path, JSON.stringify({ lastStatus: "not-a-real-status" }), "utf8");
    const state = await readState(path);
    expect(state).toEqual({ lastStatus: "ok" });
  });
});
