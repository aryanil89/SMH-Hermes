import { describe, it, expect } from "vitest";
import os from "node:os";
import { readHostComputeNode, SAMPLE_MS } from "./host-compute.js";
import { generateComputeReport } from "../mock/compute.js";
import { COMPUTE_THRESHOLDS } from "../common/thresholds.js";

describe("readHostComputeNode", () => {
  it("reports this machine's actual CPU, memory and uptime", async () => {
    const node = await readHostComputeNode();
    // Any platform that runs this suite exposes os.cpus(); a skip here would
    // hide a real regression on the one machine that matters.
    expect(node).toBeDefined();
    if (!node) return;

    expect(node.id).toBe("host-01");
    expect(node.source).toBe("real");
    expect(node.cpuPct).toBeGreaterThanOrEqual(0);
    expect(node.cpuPct).toBeLessThanOrEqual(100);
    expect(node.memPct).toBeGreaterThan(0);
    expect(node.memPct).toBeLessThan(100);

    // Cross-checked against the same builtin the reader used, so this fails if
    // the arithmetic drifts rather than merely if the numbers look plausible.
    expect(node.cpuCount).toBe(os.cpus().length);
    expect(node.memTotalGb).toBeCloseTo(os.totalmem() / 1024 ** 3, 0);
    expect(node.uptimeSec).toBeGreaterThan(0);
    expect(node.uptimeSec).toBeLessThanOrEqual(Math.ceil(os.uptime()) + 5);
    expect(node.cpuModel.length).toBeGreaterThan(0);
  });

  it("samples CPU over an interval rather than dividing counters since boot", async () => {
    // The bug this pins: os.cpus() times are cumulative since boot, so one
    // sample divided once reports average utilisation over days of uptime --
    // a near-constant low number that never responds to load, presented as
    // current CPU. The observable difference between that mistake and the
    // correct implementation is that the correct one has to WAIT: it cannot
    // return before it has taken a second sample.
    //
    // Timing, not statistics, because it is the only non-flaky signal here.
    // Asserting "busy reads higher than idle" on a 12-core machine under a
    // test runner would fail at random and get deleted, which is worse than
    // no test at all.
    const started = Date.now();
    const node = await readHostComputeNode();
    const elapsed = Date.now() - started;

    expect(node).toBeDefined();
    // -20ms of slack for timer granularity; still far above the ~0ms an
    // instantaneous since-boot division would take.
    expect(elapsed).toBeGreaterThanOrEqual(SAMPLE_MS - 20);
  });

  it("reports a per-interval value, not the machine's since-boot average", async () => {
    // Belt and braces on the same bug, from the value side. The since-boot
    // average is computable here from the same builtin, and on a host with
    // days of uptime it is pinned to a fraction of a percent. Burn CPU for
    // longer than one sampling window and the correct implementation must be
    // able to leave that number behind; the buggy one is nailed to it.
    const sinceBoot = ((): number => {
      let busy = 0;
      let total = 0;
      for (const cpu of os.cpus()) {
        const t = cpu.times;
        busy += t.user + t.nice + t.sys + t.irq;
        total += t.user + t.nice + t.sys + t.irq + t.idle;
      }
      return (busy / total) * 100;
    })();

    const spinUntil = Date.now() + SAMPLE_MS * 3;
    const reading = readHostComputeNode();
    while (Date.now() < spinUntil) {
      /* deliberately saturating this core for the whole sampling window */
    }
    const node = await reading;

    expect(node).toBeDefined();
    if (!node) return;
    // One core of twelve pegged for the window is ~8.3 points of headroom over
    // an idle baseline, so requiring the reading to clear the since-boot
    // average by a single point is comfortably inside the margin while still
    // being impossible for an implementation that returns that average.
    expect(node.cpuPct).toBeGreaterThan(sinceBoot + 1);
  });

  it("never claims a thermal-throttle state it cannot measure", async () => {
    const node = await readHostComputeNode();
    // Absent, not false. `false` would mean "measured, not throttling"; there
    // is no counter for this laptop that Node can read.
    expect(node?.thermalThrottle).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(node ?? {}, "thermalThrottle")).toBe(false);
  });

  it("says it is running rather than rolling for it", async () => {
    const node = await readHostComputeNode();
    // This code is executing on the host, so the service answering is running
    // by definition. The simulated nodes roll a die; here there is no die.
    expect(node?.serviceState).toBe("running");
  });

  it("derives status from the same thresholds the simulated fleet uses", async () => {
    const node = await readHostComputeNode();
    if (!node) return;
    const expectedOk =
      node.cpuPct < COMPUTE_THRESHOLDS.cpuPct.warning &&
      node.memPct < COMPUTE_THRESHOLDS.memPct.warning;
    if (expectedOk) expect(node.status).toBe("ok");
    else expect(["warning", "critical"]).toContain(node.status);
  });
});

describe("the real/simulated seam", () => {
  it("labels every simulated node so a real one is never confusable", () => {
    const report = generateComputeReport({ seed: 7 });
    expect(report.nodes.length).toBeGreaterThan(0);
    for (const node of report.nodes) {
      expect(node.source).toBe("mock");
    }
  });

  it("leaves the simulated fleet reproducible and untouched by the real read", async () => {
    // Wire B must not have made the mock path depend on live machine state:
    // the seeded fleet is what keeps a staged scenario repeatable.
    const a = generateComputeReport({ seed: 7 });
    await readHostComputeNode();
    const b = generateComputeReport({ seed: 7 });
    expect(a.nodes).toEqual(b.nodes);
  });
});
