# Performance diagnosis & design proposal — for review

Author: benchmark session (Claude), 2026-08-05 PM.
Status: **REVIEWED** 2026-08-05 by the repo-owning agent session. Verdicts are
inline under each proposal. Outcome: P1 MODIFY (right diagnosis, wrong target),
P2 REJECT for the demo, P3 REJECT-as-new-work / verify instead, P4 ACCEPT,
P5 DEFER upstream. Shipped: the P1 skills-catalogue cut (see P1's verdict).
Composition measurements that drove these calls are in §0; demo-day steps in §6.
Evidence base: `llm-serving-bench/RESULTS.md` (all numbers measured 2026-08-05).

## 0. Request composition — measured (settles P1's Action A)

GenieX exposes no `/tokenize`, so each block was sent alone with `max_tokens: 1`
and `usage.prompt_tokens` diffed against a trivial baseline — **real counts
through the production chat template**, not estimates.

| Block | measured tok | share of the 9,825 fixed overhead |
|---|---|---|
| Built-in Hermes tool schemas (residual) | **4,353** | 44% |
| System prompt (15,006 chars) | **3,435** | 35% |
| → of which the `## Skills (mandatory)` catalogue | **1,535** | 16% |
| MCP tool schemas (6 servers / 10 tools, 7,611 chars) | **2,028** | 21% |
| Chat-template framing | 9 | — |
| History (at the measured 12,670-tok turn shape) | ~2,845 | — |

**78% of a real request is fixed overhead; only 22% is conversation.** The
ranking matters: MCP schemas are the *smallest* of the three fixed blocks, so
P1's Action B (prune MCP) targets the wrong thing — and `rules` + `assessment`
are exactly what the demo needs. Method: `llm-serving-bench/` probes; raw
numbers in `RESULTS.md`.

## 1. Diagnosis: the system is prefill-bound

- A real Hermes turn (12,670 tok in / 105 out, measured from state.db) takes
  **~68–77 s**, of which **~61–70 s is prefill** and ~7 s is decode. Decode speed
  is irrelevant at this shape; tokens-IN is the entire latency story.
- Prefill throughput **degrades with context**: 382 tok/s @ 3.9K → 206 @ 12.5K →
  108 @ 31.8K. Worst legal turn (32K, compression threshold) = **293 s**.
- **Measured 2026-08-05: GenieX v0.3.18 has NO cross-request KV/prefix cache.**
  A byte-identical 12.5K repeat re-prefills at full cost, and llama.cpp's
  `cache_prompt: true` param is ignored (`llm-serving-bench/cache_probe.py`).
  So every turn re-reads the whole history from scratch, and nothing we send
  per-request can change that. Prompt *size* is the only lever we own.

## 2. Proposals, ranked (levers we own)

### P1 — Prompt diet: cut the resting prompt from ~12.7K toward ~5–6K
The 12.7K request shape is mostly fixed overhead (system prompt + MCP tool
schemas + history). config.yaml has `tool_search` **off**, so every schema from
every MCP server (now incl. rules + assessment) ships on every turn.
- Action A: measure the actual composition of one real request (state.db /
  provider log): how many tokens are tool schemas vs system prompt vs history?
- Action B: enable `tool_search` or prune MCP servers/tools to the demo set.
- Expected: each 1K tokens removed saves ~5 s/turn at the 12.5K operating point
  (206 tok/s), more later in the session (rates halve as context grows) — and
  it compounds: smaller resting prompt also delays the compression ceiling.
- Risk to weigh: does Hermes tool_search cost an extra model call per turn on
  this slow box? Was it turned off deliberately? Reviewer knows the history.

**Reviewer verdict: MODIFY — right diagnosis, wrong target. Shipped.**

Action A is answered in §0. The three sub-decisions:

- **Do NOT re-enable `tool_search`. It was deliberate and it is not a token
  trade — it is a round-trip trade.** `tools/tool_search.py` is a 3-hop bridge
  (`tool_search` → `tool_describe` → `tool_call`); each hop is a separate model
  call, and with no prefix cache each is a **full re-prefill (~60–70 s)**. So it
  spends 2–3 extra prefills to save 2,028 tokens (~10 s). Worse, the recorded
  behaviour is that Qwen3-4B does not perform the dance at all: asked to arm an
  alert it burned one call, replied with 931 chars of prose, and left
  `rules.json` empty (`config.yaml:127-141`, `README.md:439`,
  `RUNBOOK.md:283`). This is a correctness rejection, not just a latency one.
- **Do NOT prune `mcp_servers`.** §0 shows it is the smallest fixed block, and
  `get_incident_assessment` correlates all four families in one call — dropping
  `network`/`storage`/`compute` would save ~390 tok (~2 s) and gut both the demo
  story and the one-call-instead-of-four latency defence.
  `platform_toolsets.telegram` is *already* trimmed to
  `[terminal, skills, cronjob]`, so that lever was largely spent earlier.
- **DO cut the skills catalogue — this is the real prize, and it shipped.** The
  `## Skills (mandatory)` block rendered **63 entries / 8,201 chars** on every
  model call; exactly one (`environmental-watch`) is used here. The rest are
  ASCII video, Manim, Polymarket, Hue, Notion, PDF editing, songwriting, …

  Mechanism (config, not a patch): `skills.platform_disabled.telegram` with 71
  names. Resolution is `global_disabled ∪ platform_disabled[platform]`
  (`agent/skill_utils.py:420-455`); the catalogue renderer filters on it
  (`agent/prompt_builder.py:1619`), it is part of the render cache key (`:1626`)
  so there is no stale-cache path, it matches either `frontmatter_name` or
  `skill_name` (`:1655`), and the same check gates `skill_view`
  (`tools/skills_tool.py:655-665`) — a disabled skill is neither advertised nor
  loadable, so there is no half-state.

  Why config and not deleting directories: 13 of the 14 categories ship in the
  `hermes-agent/skills/` **bundle** as well as `$HERMES_HOME/skills/` (only
  `environmental-watch` is user-authored), so a directory prune would not stick.
  Patching prompt text would repeat the non-stream-patch lesson. `platform_disabled`
  is also platform-scoped: **CLI sessions keep all 63 skills.**

  **Measured result: system prompt 3,444 → 1,909 tok = 1,535 tok saved per model
  call** (skills block 8,201 → 1,833 chars). ~7.5 s/call at 206 tok/s, ~10.2 s at
  the degraded 150 tok/s late-session rate. Because each tool call is its own
  re-prefill, a 3-call turn saves **~22 s**.

  Not done, deliberately: the 4,353-tok built-in tool schema block is the largest
  single block but Hermes exposes **no per-tool disable** — granularity is
  toolset-level only (`platform_toolsets`, `disabled_toolsets`), and the Telegram
  toolset is already minimal. Cutting further means dropping a whole toolset.

### P2 — Lower `compression.threshold` 0.5 → ~0.25 as a latency cap
Caps the worst turn at ~16K (~85 s @ ~150 tok/s) instead of 32K (293 s).
- Counter-cost the reviewer must price: compression itself is an LLM call over
  the history; firing it at 16K means it fires more often and each event blocks
  a turn. Net win only if compression events are cheaper than the prefill they
  save across a typical session. May be demo-config only (snappy) vs daily-use
  config (0.5).
- Hard constraint either way: **never raise above 0.5** — ~60K crashes the NPU
  (`RESULTS.md` stability finding 1).

**Reviewer verdict: REJECT for the demo. Keep 0.5. Not changed.**

The counter-cost was priced, and it inverts the proposal. The load-bearing
detail is the target semantics: `target_tokens = threshold_tokens ×
summary_target_ratio` (`agent/context_compressor.py:2044`, `:1568`) — the target
is a fraction **of the threshold**, not of `context_length`. And the ~9,825 tok
of fixed overhead (§0) **does not compress**; it is re-sent every turn either way.

| | threshold 0.5 | threshold 0.25 |
|---|---|---|
| Fires at | 32,768 tok | 16,384 tok |
| History headroom before 1st event | 22,943 tok ≈ **~25 turns** | 6,559 tok ≈ **~7 turns** |
| Tail budget kept after an event | 6,554 tok | 3,277 tok |
| Headroom between events | ~15,900 tok ≈ ~17 turns | ~2,800 tok ≈ **~3 turns** |
| Cost per event (prefill + summary) | ~334 s | ~130 s |

At 0.25 the fixed overhead eats 60% of the window before the conversation says
anything, so compression fires roughly **every three turns**, each event
reclaiming only ~3.3K tokens for a ~130 s stall. A demo session reset per P4
climbs to only ~19K over ten turns and at 0.5 **never compresses at all** — the
293 s worst case it defends against is unreachable. Lowering the threshold would
*introduce* the stall it is meant to prevent, mid-demo.

For long daily-use sessions 0.25 does win on the mean (~124 s vs ~211 s per
turn, because mean context halves) — so it is a defensible **daily profile**,
never a demo change. Revisit post-hackathon, ideally alongside P5.
**Never raise above 0.5** — that constraint stands unchanged.

### P3 — Perceived latency: Telegram "typing…" action during turns
Non-stream mode means the user stares at silence for 60–300 s. Sending
`sendChatAction: typing` every ~5 s while a turn runs is cheap, provider-
agnostic, and doesn't touch the fragile streaming path.
- The deeper fix — re-enable streaming by synthesizing the missing
  `finish_reason` on stream close in `conversation_loop.py` — is higher risk
  (that's the exact bug that forced `HERMES_FORCE_NONSTREAM=1`) and probably
  not a before-Friday change. Reviewer to judge.

**Reviewer verdict: REJECT as new work — it already exists. Verify instead.**

Hermes ships this end-to-end; there is nothing to build:

- `typing_indicator: bool = True` (`gateway/config.py:621`) — default on, and
  **not overridden** in our `config.yaml`.
- `_keep_typing` (`gateway/platforms/base.py:4677`) refreshes every 2 s because
  Telegram's bubble expires at ~5 s, with a 1.5 s per-call timeout so a slow
  round trip cannot stall the cadence.
- The Telegram adapter implements `sendChatAction` with transient-error
  cooldowns, forum `message_thread_id` handling, re-trigger after each sent
  message (Telegram clears typing on delivery), and pause/resume around
  dangerous-command approvals.

So the action is a **five-minute live test** (send one message, watch for the
bubble), not a feature. If the bubble is missing, that is a bug hunt.

Agreed on the streaming `finish_reason` synthesis: that is the exact bug that
forced `HERMES_FORCE_NONSTREAM=1`. Post-Friday, not this week.

One risk this proposal surfaced that is **higher severity than the latency it
addresses**: on 2026-08-04 the gateway lost DNS for `api.telegram.org`
(`getaddrinfo failed`) *and* the hard-coded fallback IPs failed. Those errors are
stale — the log's last write is 2026-08-04 23:48 and Telegram has been connected
since — but the demo has a hard dependency on that resolution working on venue
Wi-Fi. See the demo-day checklist (§6).

### P4 — Demo-day tactic (already documented, zero code)
Reset the Telegram session before the demo: fresh sessions run ~1 min/turn;
the 32K ceiling turn is ~5 min. `RESULTS.md` "Session token budget".

**Reviewer verdict: ACCEPT — and it is the strongest demo lever we have.**

Zero code, largest effect, and it is what makes P2 unnecessary: a reset session
reaches only ~19K over ten turns, so it never touches the compression threshold
at 0.5 and never pays the 293 s ceiling turn. Combined with the P1 skills cut,
first-turn fixed overhead drops 9,825 → ~8,290 tok, which both speeds every turn
and pushes the compression ceiling further out. Folded into the demo-day
checklist (§6) so it is a step someone performs, not a note someone remembers.

### P5 — Task-level NPU+GPU split (post-Friday experiment, not layer-level)
Layer/op-level load sharing is a **measured loser** on this workload: GenieX
`--compute hybrid` halves prefill (203 vs 382 tok/s) for +3 tok/s decode →
~69 s vs ~41 s modeled iterations. Splitting one sequential LLM inference
across engines pays activation-transfer costs in the phase (prefill) the NPU
already dominates. QUAD's balanced-mode philosophy (heavy layers → NPU) agrees.
The interesting split is **by task, not by layer**: GPU fails only `tools`
requests but is the fastest engine tool-free (~650 prefill / ~110 decode).
Hermes compression summarization calls are tool-free → route them to a small
dedicated GPU server (`--compute gpu --nctx 16384`, port ≠ 18181). A GPU
process does not touch the Hexagon DSP, so the dual-NPU-process instability
does not apply — but verify commit headroom (32 GB box; two 64K servers OOM'd)
and that compression output quality holds. Would make P2's counter-cost mostly
vanish (compression events become fast + off the critical engine).

**Reviewer verdict: DEFER — sound idea, but Hermes cannot route it today.
File upstream; do not patch locally.**

The insight is good — layer-level hybrid is a measured loser while task-level
routing exploits a real asymmetry (GPU fails only `tools` requests; compression
summarization is tool-free). The blocker is plumbing:

- `summary_model_override` is hardcoded `None` at `agent/agent_init.py:2472` —
  no config key wires it.
- The compressor is constructed with `base_url=agent.base_url` — a single
  endpoint inherited from the agent.
- Even if the override were exposed, it only sets `call_kwargs["model"]`
  (`agent/context_compressor.py:3787`) — a **model name on the same endpoint**,
  never a different port.

So P5 needs a code change to the vendored `hermes-agent`: precisely the class of
local patch `hermes update` reverts (the non-stream lesson). The right move is an
upstream feature request: *compression should accept a routable endpoint
(base_url + model), not just a model override.*

Two assumptions to test before building on it, either way:
1. "A GPU process does not touch the Hexagon DSP" is **plausible but unverified**
   — `RESULTS.md` stability finding 2 was specifically about two *Hexagon*
   processes. Probe it; do not assume it.
2. Memory headroom on a 31.6 GB box with a ~12 GB NPU server already resident.

Note it pairs with the P2 daily profile: cheap compression is what would make a
0.25 threshold attractive for long sessions.

## 3. Upstream watch list (levers we don't own — recheck per GenieX release)

- **Prompt/KV caching**: `python llm-serving-bench/cache_probe.py` — the day
  B-exact-repeat drops to seconds, P1/P2 become secondary and turns drop to ~2 s
  + decode. Biggest possible single win; purely upstream today.
- **GPU tool-call bug**: `python llm-serving-bench/bench.py --modes gpu` —
  GPU showed 2–3× NPU prefill tool-free but fails all `tools` requests.
- ~60K NPU prefill crash (ceiling between 32K and 60K, untested).

## 4. Confirmed non-levers (measured; do not revisit without new data)

- Hybrid compute: 2× decode but half the prefill — wrong trade at 82%-prefill
  turns (~69 s vs ~41 s modeled).
- K-quants (Q4_K_M): silent CPU fallback, ~10× slower iterations.
- CPU mode: 9× slower and 8.7× more energy per token; also thermal-throttles.

## 5. Notes for the reviewer

- Cache-probe absolute rates today (162–175 tok/s at 12.5K) ran below the
  clean 206 tok/s — other load was on the box; the no-cache conclusion is about
  *ratios* (repeat ≈ cold) and is unaffected. Candidate for that load: the
  `uno-q/pull_sensor_log.ps1` adb pull loop was running during the probe window.
  Not the geniex supervisor — its poll is 15 s and it does not probe over HTTP.
- Constraints that still stand: don't run a second Hexagon process next to
  production; don't `hermes update` (reverts the non-stream patch); check
  `Get-NetTCPConnection -LocalPort 18181` before touching geniex; never echo
  tokens from `.env` / `telegram_info`.

### On the geniex supervisor (asked during review)

Yes, `scripts/geniex-supervisor.ps1` is still running and still restarts geniex
by image name — that is what killed the bench servers three times on 2026-08-05.
Chain: bench server on 18191 → second Hexagon process destabilises the DSP →
production on 18181 dies → the supervisor's restart path runs
`Get-Process geniex | Stop-Process -Force` (`:149-152`), which takes the bench
server with it.

**Left unchanged on purpose, and it should stay that way through Friday.** Its
health check is process-alive + socket-owner, deliberately *not* HTTP (`:62-74`,
with a comment recording that a `/v1/models` probe took 1m42s during inference),
so a legitimate 293 s turn can never be mistaken for a dead server. During the
demo only one geniex exists, so "kill every geniex" is identical to "kill the
dead one" — which is the auto-restart behaviour the supervisor exists to provide.
The image-wide kill only bites when a second server is running.

Post-hackathon, bench-only fix: scope the kill to the PID owning 18181, or add a
pause-file the supervisor honours while benchmarks run. Modifying a watchdog days
before the demo is a worse risk than a bug that only fires during benching.

## 6. Demo-day checklist

Run in order. Item 1 is the highest-severity item in this document — it is the
only single point of failure that silently kills the whole demo.

1. **Venue Wi-Fi pre-check: resolve and reach `api.telegram.org`.** On
   2026-08-04 the gateway lost DNS (`getaddrinfo failed`) *and* its hard-coded
   fallback IPs failed. Test on the actual venue network, and have a phone
   hotspot ready as fallback. No amount of prefill tuning matters if the bot
   cannot reach Telegram.
2. **Reset the Telegram session** (P4). Keeps turns in the ~1 min band and
   guarantees the compression threshold is never reached.
3. **Typing-bubble live test** (P3). Send one message; confirm the "typing…"
   bubble appears within ~2 s. This is the whole of P3's remaining work.
4. **Confirm serving state**: `Get-NetTCPConnection -LocalPort 18181` shows a
   `geniex` owner, and the supervisor window is running.
5. **Confirm the prompt diet is live**: the newest `system_prompts` row in
   `state.db` should show a skills block of ~1,833 chars, not 8,201. If it still
   reads 8,201, the gateway was not restarted after the `config.yaml` edit
   (`RUNBOOK.md` — config is read at boot only).
