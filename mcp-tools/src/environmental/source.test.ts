import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getEnvironmentalReading, statusForReading } from "./source.js";

const ORIGINAL_ENV = { ...process.env };

describe("getEnvironmentalReading", () => {
  beforeEach(() => {
    delete process.env.UNOQ_HOST;
    delete process.env.UNOQ_USER;
    delete process.env.UNOQ_TIMEOUT_MS;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("falls back to mock when UNOQ_HOST is not set, with a clear reason", async () => {
    const result = await getEnvironmentalReading({ seed: 1 });
    expect(result.source).toBe("mock");
    expect(result.fallbackReason).toMatch(/UNOQ_HOST is not set/);
    expect(["ok", "warning", "critical"]).toContain(result.status);
  });

  it("falls back to mock when the real transport rejects (board unreachable), never throwing", async () => {
    process.env.UNOQ_HOST = "10.0.0.99";
    const result = await getEnvironmentalReading({
      seed: 2,
      timeoutMs: 50,
      exec: async () => {
        throw new Error("ssh: connect to host 10.0.0.99 port 22: Connection refused");
      },
    });
    expect(result.source).toBe("mock");
    expect(result.fallbackReason).toMatch(/Connection refused/);
  });

  it("falls back to mock (never hangs) when the real transport never resolves", async () => {
    process.env.UNOQ_HOST = "10.0.0.99";
    const start = Date.now();
    const result = await getEnvironmentalReading({
      seed: 3,
      timeoutMs: 50,
      exec: () => new Promise(() => {}), // never resolves/rejects
    });
    const elapsed = Date.now() - start;
    expect(result.source).toBe("mock");
    expect(result.fallbackReason).toMatch(/timed out/);
    // Bounded by timeoutMs + the small safety-net buffer in source.ts, with headroom for test jitter.
    expect(elapsed).toBeLessThan(2000);
  }, 3000);

  it("uses the real reading when the transport succeeds", async () => {
    process.env.UNOQ_HOST = "192.168.1.50";
    const result = await getEnvironmentalReading({
      exec: async () => JSON.stringify({ temperature_c: 22.5, humidity_pct: 41, leak_detected: false }),
    });
    expect(result.source).toBe("real");
    expect(result.fallbackReason).toBeUndefined();
    expect(result.temperatureC).toBe(22.5);
    expect(result.humidityPct).toBe(41);
    expect(result.leakDetected).toBe(false);
    expect(result.status).toBe("ok");
  });

  it("falls back to mock on a malformed real payload", async () => {
    process.env.UNOQ_HOST = "192.168.1.50";
    const result = await getEnvironmentalReading({
      seed: 4,
      exec: async () => "not json at all",
    });
    expect(result.source).toBe("mock");
    expect(result.fallbackReason).toMatch(/did not return valid JSON/);
  });
});

describe("statusForReading", () => {
  it("leak detected always forces critical regardless of temp/humidity", () => {
    expect(statusForReading({ temperatureC: 20, humidityPct: 30, leakDetected: true })).toBe("critical");
  });

  it("computes status from temperature/humidity thresholds when no leak", () => {
    expect(statusForReading({ temperatureC: 20, humidityPct: 30, leakDetected: false })).toBe("ok");
    expect(statusForReading({ temperatureC: 31, humidityPct: 30, leakDetected: false })).toBe("warning");
    expect(statusForReading({ temperatureC: 36, humidityPct: 30, leakDetected: false })).toBe("critical");
  });
});
