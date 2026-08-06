import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuredBackend, identifyFaces } from "./identify.js";
import type { IdentityBackend } from "./identify.js";
import type { RosterEntry } from "./types.js";

/**
 * A stand-in for the face-cpu Python script, which does not exist yet -- T1
 * hardens the TypeScript side of the contract before the Python side is
 * written. `process.execPath` (the node binary already running these tests)
 * plays "python": it ignores stdin and writes whatever JSON or exit code the
 * test configured via env vars, so `fromPython`'s contract can be exercised
 * end to end with a real child process and no interpreter or model involved.
 */
const FAKE_VISION_SCRIPT = `
const code = Number(process.env.IDENTIFY_TEST_EXIT_CODE || "0");
if (code !== 0) {
  process.stderr.write(process.env.IDENTIFY_TEST_STDERR || "boom");
  process.exit(code);
}
process.stdout.write(process.env.IDENTIFY_TEST_STDOUT || "{}");
process.exit(0);
`;

const embedding512 = (fill = 0.01): number[] => Array.from({ length: 512 }, () => fill);

function clearEnv(): void {
  delete process.env.ACCESS_IDENTITY_METHOD;
  delete process.env.ACCESS_PYTHON;
  delete process.env.ACCESS_VISION_SCRIPT;
  delete process.env.ACCESS_VISION_TIMEOUT_MS;
  delete process.env.IDENTIFY_TEST_STDOUT;
  delete process.env.IDENTIFY_TEST_EXIT_CODE;
  delete process.env.IDENTIFY_TEST_STDERR;
}

describe("configuredBackend", () => {
  beforeEach(clearEnv);
  afterEach(clearEnv);

  const cases: Array<[string | undefined, IdentityBackend]> = [
    [undefined, "stub"],
    ["stub", "stub"],
    ["qr-badge", "qr-badge"],
    ["badge", "qr-badge"],
    ["python", "python"],
    ["face", "python"],
    ["face-npu", "python"],
    ["face-cpu", "python"],
    ["PYTHON", "python"],
  ];

  it.each(cases)("maps %s to %s", (raw, expected) => {
    if (raw === undefined) delete process.env.ACCESS_IDENTITY_METHOD;
    else process.env.ACCESS_IDENTITY_METHOD = raw;
    expect(configuredBackend()).toBe(expected);
  });

  it("is the kill switch: an unrecognized value falls back to stub rather than throwing or spawning python", () => {
    process.env.ACCESS_IDENTITY_METHOD = "definitely-not-a-real-backend";
    expect(configuredBackend()).toBe("stub");
  });
});

describe("identifyFaces via the python backend", () => {
  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), "identify-"));
    const scriptPath = join(dir, "fake-vision.cjs");
    await writeFile(scriptPath, FAKE_VISION_SCRIPT, "utf8");
    process.env.ACCESS_IDENTITY_METHOD = "python";
    process.env.ACCESS_PYTHON = process.execPath;
    process.env.ACCESS_VISION_SCRIPT = scriptPath;
  });

  afterEach(clearEnv);

  it("resolves a clean cpu response to face-cpu with no degrade", async () => {
    process.env.IDENTIFY_TEST_STDOUT = JSON.stringify({
      embeddings: [embedding512()],
      boxes: [[0, 0, 1, 1]],
      device: "cpu",
    });

    const result = await identifyFaces({ imageBase64: "aGVsbG8=", roster: [] });

    expect(result.method).toBe("face-cpu");
    expect(result.faces).toHaveLength(1);
    expect(result.degradedFrom).toBeUndefined();
  });

  it("never reports face-npu when the backend response has no device key", async () => {
    // The regression this guards: a missing `device` used to fall through the
    // `parsed.device === "cpu" ? "face-cpu" : "face-npu"` ternary's else
    // branch, claiming NPU work that never happened. It must now degrade
    // instead of ever reaching "face-npu".
    process.env.IDENTIFY_TEST_STDOUT = JSON.stringify({
      embeddings: [embedding512()],
    });

    const result = await identifyFaces({ imageBase64: "aGVsbG8=", roster: [] });

    expect(result.method).not.toBe("face-npu");
    expect(result.degradedFrom).toMatch(/unrecognized device/);
  });

  it("rejects an embedding of the wrong dimension instead of scoring it", async () => {
    process.env.IDENTIFY_TEST_STDOUT = JSON.stringify({
      embeddings: [[1]],
      device: "cpu",
    });
    const roster: RosterEntry[] = [
      { name: "Alice", embedding: [1], enrolledAt: "2026-08-04T21:00:00.000Z", method: "face-cpu" },
    ];

    const result = await identifyFaces({ imageBase64: "aGVsbG8=", roster });

    expect(result.degradedFrom).toMatch(/invalid embedding/);
    expect(result.faces.some((f) => f.match === "known")).toBe(false);
  });

  it("does not let a dimension-mismatched roster entry match a validly-shaped probe embedding", async () => {
    // Hand-enrolled via the phone UI, which has no way to enforce the model's
    // output shape -- exactly the roster entry T1.2's dimension filter exists
    // to neutralise, alongside a probe embedding that is otherwise valid.
    process.env.IDENTIFY_TEST_STDOUT = JSON.stringify({
      embeddings: [embedding512(0.5)],
      device: "cpu",
    });
    const roster: RosterEntry[] = [
      { name: "Stray", embedding: [1], enrolledAt: "2026-08-04T21:00:00.000Z", method: "face-cpu" },
    ];

    const result = await identifyFaces({ imageBase64: "aGVsbG8=", roster });

    expect(result.degradedFrom).toBeUndefined();
    expect(result.faces[0]?.match).toBe("unknown");
  });

  it("resolves an empty-but-successful response to zero faces on face-cpu, not a degrade", async () => {
    // A quality rejection (no_face / face_too_small) is expected to exit 0
    // with empty embeddings, not a non-zero exit -- that is what lets
    // decide.ts:104-106 say "capture contained no detectable face -- retake
    // needed" instead of either a phantom unknown face or a false "pipeline
    // unavailable" degrade. This pins the TypeScript half of that contract.
    process.env.IDENTIFY_TEST_STDOUT = JSON.stringify({
      embeddings: [],
      boxes: [],
      device: "cpu",
    });

    const result = await identifyFaces({ imageBase64: "aGVsbG8=", roster: [] });

    expect(result.faces).toHaveLength(0);
    expect(result.method).toBe("face-cpu");
    expect(result.degradedFrom).toBeUndefined();
  });

  it("degrades to face-detect-only and records degradedFrom when the script exits non-zero", async () => {
    process.env.IDENTIFY_TEST_EXIT_CODE = "1";
    process.env.IDENTIFY_TEST_STDERR = "camera not found";

    const result = await identifyFaces({ imageBase64: "aGVsbG8=", roster: [] });

    expect(result.method).toBe("face-detect-only");
    expect(result.degradedFrom).toMatch(/camera not found/);
  });
});
