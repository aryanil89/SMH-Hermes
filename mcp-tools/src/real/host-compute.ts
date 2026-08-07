import os from "node:os";
import { round1 } from "../common/round.js";
import { statusForValue, worstStatus } from "../common/alerts.js";
import { COMPUTE_THRESHOLDS } from "../common/thresholds.js";
import type { ComputeNode } from "../mock/compute.js";

/**
 * The one compute node that is not invented: this machine.
 *
 * Everything else in the compute/storage/network families is generated
 * (mock/compute.ts and friends) because a hackathon rack does not exist. The
 * laptop running Hermes does, and it is the Copilot+ PC the whole project is
 * about -- so reporting its real CPU, memory and uptime costs one Node builtin
 * and turns "all infrastructure telemetry is simulated" into a statement with
 * an exception a judge can verify by opening Task Manager.
 *
 * Every node carries `source`, so a reader never has to know which of these
 * two files produced a given row. That is the entire point of the field: an
 * unlabelled real number next to five invented ones is worse than no real
 * number at all, because it invites the reader to trust all six.
 */

/** How long to wait between CPU samples. Exported so the test can pin it. */
export const SAMPLE_MS = 200;

/** Sum of busy and total jiffies across all cores. */
function cpuTotals(): { busy: number; total: number } {
  let busy = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const t = cpu.times;
    busy += t.user + t.nice + t.sys + t.irq;
    total += t.user + t.nice + t.sys + t.irq + t.idle;
  }
  return { busy, total };
}

export interface HostComputeNode extends ComputeNode {
  source: "real";
  /** e.g. "Snapdragon(R) X Elite - X1E80100 - Qualcomm(R) Oryon(TM) CPU". */
  cpuModel: string;
  cpuCount: number;
  memTotalGb: number;
}

/**
 * Read this host's actual CPU/memory/uptime. Never throws.
 *
 * CPU is a delta between two samples of `os.cpus()` rather than an instant
 * reading, because those counters are cumulative since boot: dividing them
 * once yields the average utilisation over ~3.7 days of uptime, which is a
 * meaningless ~2% no matter what the machine is doing right now. `os.loadavg()`
 * is not an option -- it returns [0,0,0] on Windows, and a hard-coded zero
 * presented as "real" would be the worst reading in the file.
 *
 * Returns undefined if the platform gives us nothing usable, so the caller
 * falls back to the simulated fleet rather than reporting a fabricated zero.
 */
export async function readHostComputeNode(): Promise<HostComputeNode | undefined> {
  try {
    const cpus = os.cpus();
    if (!cpus.length) return undefined;

    const first = cpuTotals();
    await new Promise((resolve) => setTimeout(resolve, SAMPLE_MS));
    const second = cpuTotals();

    const totalDelta = second.total - first.total;
    // A zero delta means the counters did not move (a virtualised or
    // permission-restricted host). Reporting 0% CPU there would be a
    // measurement claim we cannot make, so decline the whole node.
    if (totalDelta <= 0) return undefined;
    const cpuPct = Math.min(100, Math.max(0, ((second.busy - first.busy) / totalDelta) * 100));

    const totalMem = os.totalmem();
    if (totalMem <= 0) return undefined;
    const memPct = ((totalMem - os.freemem()) / totalMem) * 100;

    const status = worstStatus(
      statusForValue(cpuPct, COMPUTE_THRESHOLDS.cpuPct, "high"),
      statusForValue(memPct, COMPUTE_THRESHOLDS.memPct, "high"),
    );

    return {
      id: "host-01",
      cpuPct: round1(cpuPct),
      memPct: round1(memPct),
      uptimeSec: Math.floor(os.uptime()),
      // Not inferred: this code is executing on the host, so the service
      // answering the question is by definition running. The simulated nodes
      // roll a die for this; here there is nothing to roll.
      serviceState: "running",
      // `thermalThrottle` is deliberately ABSENT rather than false. The
      // simulated nodes derive it from the rack's ambient temperature; there
      // is no equivalent counter for this laptop that Node can read, and
      // `false` would assert "measured, not throttling". Absent means "not
      // measured", which is the truth.
      status,
      source: "real",
      cpuModel: cpus[0]?.model.trim() ?? "unknown",
      cpuCount: cpus.length,
      memTotalGb: round1(totalMem / 1024 ** 3),
    };
  } catch {
    return undefined;
  }
}
