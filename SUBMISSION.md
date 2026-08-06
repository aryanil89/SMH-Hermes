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
- [ ] **Personal GitHub repository, public** — confirm the repo is public under a personal
  account before submitting the link.
- **README contents** (all four are required):
  - [x] Application description — [README.md](README.md) intro.
  - [x] Names and emails of ALL team members — README team table: Indranil Acharya,
    Christopher Gould, John Koch (completed 2026-08-06).
  - [x] Setup instructions from scratch, including dependencies —
    [README §0. Setting this up on a fresh machine](README.md#0-setting-this-up-on-a-fresh-machine).
  - [x] Run and usage instructions —
    [README § Judge quickstart](README.md#judge-quickstart--three-rungs-pick-your-hardware)
    (minimum path, expected outputs, fallback modes) and
    [README § Run it yourself](README.md#run-it-yourself--the-whole-flow-in-start-order)
    (the full seven-piece flow).
- [x] **An open-source license** — Apache-2.0.
- [ ] **Runnable using the provided instructions** — verified end to end on the demo
  laptop; quickstart rung 1 verified 2026-08-06 **from a fresh `git clone` in a clean
  directory**: `npm install` → `npm run build` → 327/327 tests, and the environmental
  smoke command returned the documented honest-mock fallback with its reason string.
  Still recommended before submission: one walkthrough of the full README §0 provisioning
  (rungs 2–3) by a team member who did not write it.
- [x] **Installs and runs on the intended Copilot+ PC** — the Snapdragon X Elite demo
  laptop is the target machine; all instructions are written for it, with the x64 CPU
  fallback documented.
- [x] **Deployable readiness** — runs from source with a reproducible install path,
  pinned model artifacts (SHA256-verified), health endpoints, and autostart scripts
  (`scripts/install-autostart.ps1`).
- [ ] **Submit the GitHub link via the Microsoft Form by Friday 12:00 PM PST** — one
  submission per team. The plan of record ([PROGRESS.md](PROGRESS.md)) says **submit
  early** — do not wait for the deadline.
- [ ] **Every team member submits the feedback form by Friday noon** — survey link arrives
  by email Thursday morning. Mandatory, per deck p.7 and p.9.

## Recommended (optional per the deck — all present)

- [x] **Tests and testing instructions** — `cd mcp-tools; npm test` → **29 files /
  327 tests, all passing** (verified 2026-08-06). Full layer-by-layer procedure:
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
| Technical Implementation (40) — resource utilization, optimization, latency, energy | [docs/EVIDENCE.md](docs/EVIDENCE.md) — the one-stop index: NPU 382 tok/s vs CPU 35 prefill, 471 J/query NPU vs ~8.7× CPU energy/token, per-op Hexagon profiling, prompt-composition optimization, and the same model measured on a **second Hexagon NPU** (S25 Ultra 8 Elite: 1,918 tok/s prefill / 23.1 decode, w4a16 via `genie-t2t-run` over `adb` — labeled as a different config) |
| Use-Case and Innovation (25) | README intro + [docs/POSITIONING.md](docs/POSITIONING.md); the access sentry (presence → face-cpu → human approval → audit trail; known responder suppresses the page) |
| Deployment and Accessibility (20) | [README § Judge quickstart](README.md#judge-quickstart--three-rungs-pick-your-hardware) — rung 1 runs on any Node 18+ machine in ~5 min |
| Presentation and Documentation (15) | Candid built-vs-planned line ([README § Today vs. planned](README.md#today-vs-planned)), 327 passing tests, [docs/RUNBOOK.md](docs/RUNBOOK.md), troubleshooting tables from real incidents |

## Open decisions before the demo (not submission blockers, but demo blockers)

- [ ] **Face-roster consent policy** — OPEN, and it blocks any face capture
  ([PROGRESS.md](PROGRESS.md) item 12). Options on the table: enrol judges live (consent
  as a visible act), pre-enrol consenting team members, or badge-free `stub` mode (the
  working default — the full loop, matrix, and audit trail run either way).
- [ ] **Benchmark screenshots** — capture list and instructions in
  [docs/EVIDENCE.md](docs/EVIDENCE.md).
- [ ] **Venue preflight** — run [docs/RUNBOOK.md §9](docs/RUNBOOK.md#9-venue-preflight--the-pre-demo-checklist)
  on venue WiFi Friday morning; Telegram needs a live check there (local TLS interception
  broke it once), hotspot is the fallback.
