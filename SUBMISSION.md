# Submission checklist — Snapdragon Multiverse Hackathon 2026

Every requirement from the hackathon deck (*Snapdragon Multiverse Hackathon — Internal*,
pages 7–9 and 42; the deck is Qualcomm-confidential and deliberately **not** in this repo —
`.gitignore:15-19`), each mapped to where this repo satisfies it. Unchecked boxes are the
open items — owners, act before the deadline.

**Deadline: Friday, August 7, 2026, 12:00 PM PST** — submissions *and* feedback surveys due
(deck p.6 and p.7; p.42 says 1:00 PM PST for the form — treat **12:00** as binding and
submit early). Demos run 1:00–4:15 PM; demo order is emailed Thursday morning. **A team
must demo to be eligible for a prize.**

## Mandatory requirements

- [x] **All code open source** — [Apache-2.0 LICENSE](LICENSE) at the repo root.
  - Caveat, handled: the InsightFace buffalo_s face models are licensed for
    **non-commercial research only**, so they are **not redistributed** here —
    `*.onnx` is gitignored (`.gitignore:53`); users fetch them from the InsightFace
    model zoo and verify SHA256 hashes per
    [README § Face recognition](README.md#face-recognition-face-cpu). The `face-cpu`
    rung is optional and **off by default** (`ACCESS_IDENTITY_METHOD=stub`).
- [x] **Personal GitHub repository, public** — verified 2026-08-06:
  `gh repo view aryanil89/SMH-Hermes` reports `"visibility": "PUBLIC"`.
  - Two synced mirrors exist, both verified public: **submit
    `https://github.com/aryanil89/SMH-Hermes`** on the form; `chrisxgould/SMH-Hermes`
    is the mirror teammates pull from, kept identical via PRs (#23, #24). Before
    submitting, confirm the chosen URL holds the final commit:
    `git ls-remote https://github.com/aryanil89/SMH-Hermes.git main` must match local
    `git rev-parse main`.
- **README contents** (all four are required):
  - [x] Application description — [README.md](README.md) intro.
  - [x] Names and emails of ALL team members — README team table: Indranil Acharya
    (team lead), Christopher Gould, John Koch (completed 2026-08-06; lead marked 2026-08-07).
  - [x] Setup instructions from scratch, including dependencies —
    [README §0. Setting this up on a fresh machine](README.md#0-setting-this-up-on-a-fresh-machine).
  - [x] Run and usage instructions —
    [README § Quickstart](README.md#quickstart--three-rungs-pick-your-hardware)
    (minimum path, expected outputs, fallback modes) and
    [README § Run it yourself](README.md#run-it-yourself--the-whole-flow-in-start-order)
    (the full seven-piece flow).
- [x] **An open-source license** — Apache-2.0.
- [x] **Runnable using the provided instructions** — verified three ways: end to end on
  the demo laptop; quickstart rung 1 on 2026-08-06 **from a fresh `git clone` in a clean
  directory** (`npm install` → `npm run build` → full suite passing — 327/327 at that
  verification, 361/361 today — and the environmental
  smoke command returned the documented honest-mock fallback with its reason string);
  and **independently by a team member on a second machine** (John's 2026-08-06 review
  ran install/build/test from his own clone — it also caught a test-order flake in
  `notify.test.ts`, fixed same day). Rungs 2–3 need the specific hardware and are
  covered by the demo-laptop verification.
- [x] **Installs and runs on the intended Copilot+ PC** — the Snapdragon X Elite demo
  laptop is the target machine; all instructions are written for it, with the x64 CPU
  fallback documented.
- [x] **Deployable readiness** — runs from source with a reproducible install path,
  pinned model artifacts (SHA256-verified), health endpoints, and autostart scripts
  (`scripts/install-autostart.ps1`).
- [ ] **Submit the GitHub link via the Microsoft Form by Friday 12:00 PM PST** — one
  submission per team. The plan of record ([PROGRESS.md](PROGRESS.md)) says **submit
  early** — do not wait for the deadline.
- [x] **Every team member submits the feedback form by Friday noon** — all three
  members confirmed submitted (2026-08-06). Mandatory per deck p.7 and p.9.

## Recommended (optional per the deck — all present)

- [x] **Tests and testing instructions** — `cd mcp-tools; npm test` → **30 files /
  361 tests, all passing** (verified 2026-08-07). Full layer-by-layer procedure:
  [docs/E2E_TEST.md](docs/E2E_TEST.md).
- [x] **Notes** — the [docs/](docs/) tree: architecture, runbook, watchdog, dashboard,
  positioning, workload placement, claims audit.
- [x] **References** — linked in place throughout: GenieX, Hermes Agent (MIT, Nous
  Research), InsightFace, Qwen3, arXiv 2606.11257 (energy methodology precedent), QUAD.
- [x] **Well-commented code** — see e.g. `mcp-tools/src/` (design rationale is written at
  the decision site).

## How the repo maps to the scoring rubric

| Criterion | Where the evidence lives |
|---|---|
| Technical Implementation (40) — resource utilization, optimization, latency, energy | [docs/EVIDENCE.md](docs/EVIDENCE.md) — the one-stop index: NPU 382 tok/s vs CPU 35 prefill, 471 J/query NPU vs ~8.7× CPU energy/token, per-op Hexagon profiling, prompt-composition optimization, and the same model measured on a **second Hexagon NPU** (S25 Ultra 8 Elite: 1,918 tok/s prefill / 23.1 decode, w4a16 via `genie-t2t-run` over `adb` — labeled as a different config), now wired in as a live-verified **compute failover**: dead GenieX → the phone NPU answers in ~12 s, labeled degraded |
| Use-Case and Innovation (25) | README intro + [docs/POSITIONING.md](docs/POSITIONING.md); the access sentry (presence → face-cpu → human approval → audit trail; known responder suppresses the page) |
| Deployment and Accessibility (20) | [README § Quickstart](README.md#quickstart--three-rungs-pick-your-hardware) — rung 1 runs on any Node 22+ machine in ~5 min |
| Presentation and Documentation (15) | [docs/DEMO_GUIDE.md](docs/DEMO_GUIDE.md) — the five-minute demo path (demo beats, real-vs-simulated, all measured numbers); candid built-vs-planned line ([README § Today vs. planned](README.md#today-vs-planned)), 361 passing tests, [docs/RUNBOOK.md](docs/RUNBOOK.md), troubleshooting tables from real incidents |

## Open decisions before the demo (not submission blockers, but demo blockers)

- [x] **Face-roster consent policy** — resolved 2026-08-07: three consenting team members
  pre-enrolled (2026-08-06); `stub` mode stays the default for anyone unenrolled, and live
  volunteer enrolment remains an optional demo beat with consent as a visible act
  ([PROGRESS.md](PROGRESS.md) item 12).
- [ ] **Benchmark screenshots** — capture list and instructions in
  [docs/EVIDENCE.md](docs/EVIDENCE.md).
- [ ] **Venue preflight** — run [docs/RUNBOOK.md §9](docs/RUNBOOK.md#9-venue-preflight--the-pre-demo-checklist)
  on venue WiFi Friday morning; Telegram needs a live check there (local TLS interception
  broke it once), hotspot is the fallback.
