import { execFile } from "node:child_process";
import { round1 } from "../common/round.js";
import type { EnvironmentalReading } from "./types.js";

export class UnoQSensorError extends Error {}

/** Injectable transport so tests never need a real `ssh` binary or network access. */
export type UnoQExec = (cmd: string, args: string[], timeoutMs: number) => Promise<string>;

export interface UnoQClientOptions {
  host: string;
  user?: string;
  timeoutMs?: number;
  exec?: UnoQExec;
}

/**
 * Client for the Arduino UNO Q's environmental sensor (temperature/humidity/leak).
 *
 * TODO(uno-q board bring-up, see ../../uno-q/README.md and
 * QUAD-Client-main/.claude/skills/quad-unoq/SKILL.md): the board is not provisioned yet. The
 * intended transport is SSH -- the same OS `ssh` binary + ~/.ssh/config convention documented in
 * the quad-unoq skill (no paramiko, no extra client deps), NOT the `quad-client unoq` CLI itself,
 * since that CLI has no "read sensors" subcommand -- it is scoped to app deploy/status/perf/logs.
 * Two things are still open and must be resolved once the board is available and a sensor-reading
 * program has been deployed to it (e.g. via `quad-client unoq deploy`):
 *
 *   1. `UNOQ_SENSOR_CMD` (env var, default below) -- the exact remote command/script path that
 *      prints a sensor reading. Placeholder default assumes a small script pushed to the board's
 *      workspace, e.g. `/data/local/tmp/quad/bin/read_sensors`.
 *   2. That script's stdout contract -- this client expects one line of JSON:
 *      `{"temperature_c": <number>, "humidity_pct": <number>, "leak_detected": <boolean>}`.
 *
 * Until both are wired up, every real call fails fast (unreachable host / missing command / bad
 * payload) and the caller (./source.ts) transparently falls back to mock data. Auth is assumed to
 * be SSH-key based per the quad-unoq skill's default; if the provisioned board turns out to be
 * password-auth only (as the IQ-9075 board is elsewhere in this workspace), this will need a
 * `plink`-style non-interactive path instead of the `BatchMode=yes` used below.
 */
export class UnoQClient {
  private readonly host: string;
  private readonly user: string;
  private readonly timeoutMs: number;
  private readonly execImpl: UnoQExec;

  constructor(opts: UnoQClientOptions) {
    this.host = opts.host;
    this.user = opts.user && opts.user.length > 0 ? opts.user : "root";
    this.timeoutMs = opts.timeoutMs ?? 3000;
    this.execImpl = opts.exec ?? defaultSshExec;
  }

  async readSensors(): Promise<EnvironmentalReading> {
    const remoteCmd = process.env.UNOQ_SENSOR_CMD ?? "/data/local/tmp/quad/bin/read_sensors";
    const target = `${this.user}@${this.host}`;
    const connectTimeoutSec = Math.max(1, Math.floor(this.timeoutMs / 1000));
    const raw = await this.execImpl(
      "ssh",
      ["-o", "BatchMode=yes", "-o", `ConnectTimeout=${connectTimeoutSec}`, target, remoteCmd],
      this.timeoutMs,
    );
    return parseSensorPayload(raw);
  }
}

function parseSensorPayload(raw: string): EnvironmentalReading {
  let data: unknown;
  try {
    data = JSON.parse(raw.trim());
  } catch {
    throw new UnoQSensorError(`sensor script did not return valid JSON: ${raw.slice(0, 200)}`);
  }

  const obj = data as Record<string, unknown>;
  const temperatureC = Number(obj["temperature_c"]);
  const humidityPct = Number(obj["humidity_pct"]);
  const leakDetected = Boolean(obj["leak_detected"]);

  if (!Number.isFinite(temperatureC) || !Number.isFinite(humidityPct)) {
    throw new UnoQSensorError(`sensor payload missing numeric temperature_c/humidity_pct: ${raw.slice(0, 200)}`);
  }

  // Same rounding as the log path -- the SSH pull is a fallback for the same
  // sensors, so it must not report them to a different precision.
  return { temperatureC: round1(temperatureC), humidityPct: round1(humidityPct), leakDetected };
}

function defaultSshExec(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, killSignal: "SIGKILL" }, (error, stdout, stderr) => {
      if (error) {
        const detail = stderr && stderr.trim().length > 0 ? ` (${stderr.trim()})` : "";
        reject(new UnoQSensorError(`${cmd} ${args.join(" ")} failed: ${error.message}${detail}`));
        return;
      }
      resolve(stdout);
    });
  });
}
