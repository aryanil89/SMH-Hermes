# Glossary — who does what

Start here if the other docs read like alphabet soup: GenieX, QAIRT, QNN, QUAD, HTP, GGUF, Q4_0,
W4A16, Modulino. This page says what each thing is and, more usefully, **which of them is
responsible for what**. Nothing here is new information — it's an index into
[PROGRESS.md](../PROGRESS.md), [HARDWARE_UTILIZATION.md](HARDWARE_UTILIZATION.md) and
[NPU_SPIKE_RESULTS.md](NPU_SPIKE_RESULTS.md).

> **The one sentence that unlocks the rest:**
> **the agent is not the model, and the model is not the runtime.**
> Three different things get called "the AI", and almost every point of confusion below is one of
> them being mistaken for another.

Analogy, used once and then dropped: **Hermes** is the employee. **Qwen3** is the employee's brain.
**GenieX** is the life support keeping the brain running. **Hexagon** is the neurons.

---

## 1. Cast list

### The agent stack — what we built

| Term | Its one job | Whose | Where in this repo |
|---|---|---|---|
| **Hermes Agent** | Decides *what to do*: which tool to call, what to remember, when to alert you. The self-improving part — it writes its own skills from experience. Native MCP client, built-in cron, Telegram gateway. | Nous Research (MIT) | installed on the laptop; **`HERMES_HOME` is `%LOCALAPPDATA%\hermes`** on this native-Windows install — config at `%LOCALAPPDATA%\hermes\config.yaml`. Docs that say `~/.hermes` are describing the Linux/WSL layout; that directory does not exist here. |
| **SMH-Hermes** | This repository. The project, not the agent. | us | you're in it |
| **MCP tool servers** | Expose datacenter health as callable tools: network, storage, compute (mocked) and environmental (real) — plus **assessment**, which correlates all four into one verdict in a single call, because on the NPU every extra tool call costs 2–4 minutes. | us | [../mcp-tools/src/servers/](../mcp-tools/src/servers/) |
| **`environmental-watch`** | The *proactive* path: a Hermes cron job every 5 min. Runs in **`--no-agent` script mode** — a small Python wrapper that prints a message only when an alert or recovery is due, and prints nothing otherwise (empty stdout ⇒ Hermes stays silent), so a tick costs **zero LLM tokens**. The same-named *skill* still exists, but only for manual/agent-narrated runs. | us | [../mcp-tools/cron/environmental-watch.py](../mcp-tools/cron/environmental-watch.py) · [skill](../mcp-tools/skills/environmental-watch/) |
| **`decide-alert`** | Edge-triggered alert logic with cooldown/recovery, so one hot rack doesn't spam you every 5 minutes. | us | [../mcp-tools/src/alert-skill/](../mcp-tools/src/alert-skill/) |
| **Message receipt** / **the `ack` hook** | The italic one-liner the phone gets ~2 s after asking, before the 60–300 s wait for the answer. Written by the same local model, so it names what you asked; carries a wait estimate learned from that session's own turns; states no findings, because nothing has been looked up yet. A **gateway hook** — Hermes' extension point, loaded from `%LOCALAPPDATA%\hermes\hooks\` at startup — not a fork of Hermes. | us | [../hermes-hooks/](../hermes-hooks/) |
| **Wall display** | The demo-table web page: device on the left, server and its inference in the middle, phone on the right. A **read-only observer** — it re-derives its numbers by calling the same functions the tools call, so it can't disagree with the agent, and removing it changes nothing. Local-only, no dependencies. | us | [../mcp-tools/src/dashboard/](../mcp-tools/src/dashboard/) · [DASHBOARD.md](DASHBOARD.md) |
| **`hermes-sensor-logger`** | App Lab app on the board: reads the Modulinos and appends JSON lines over three channels — a periodic climate `sensor_tick` (~every 10 s, temperature + humidity only), an event line per **button transition** in both directions (`door_open`/`door_closed`, `light_on`/`light_off`, `leak_detected`/`leak_cleared`), and `object_entered`/`object_left` on ToF presence crossings. Also drives the LED-matrix boot/connection display. A push loop `scp`-overwrites the log onto the laptop every 10 s. | us | [../uno-q/hermes-sensor-logger/](../uno-q/hermes-sensor-logger/) |

### The model

| Term | Its one job | Whose |
|---|---|---|
| **Qwen3-4B-Instruct-2507** | Produces tokens. Chosen for reliable tool-calling, which the whole pitch depends on. Has no idea your racks exist — it only knows what Hermes puts in the prompt. | Alibaba (Qwen team) |
| **GGUF** | The container file format for llama.cpp-family models. What we actually load. | llama.cpp project |
| **Q4_0 / Q4_K_M** | Two 4-bit quantization schemes inside GGUF. **Not interchangeable here** — see §5. | llama.cpp project |
| **W4A16** | 4-bit weights, 16-bit activations — the quantization of the AI Hub NPU bundle. Benchmark-only for us. | Qualcomm |
| **Quantization** | Shrinking weights (16-bit → 4-bit) so a model fits and runs fast, trading a little accuracy. | — |
| **`nctx` / KV cache / prefill / decode** | Context window size (`--nctx 65536` = 64K tokens); the memory holding the conversation so far; the cost of reading your prompt; the speed of writing the reply (~15–16 tok/s for us). | — |

### Qualcomm software — the confusing part

| Term | Its one job | Relationship to the others |
|---|---|---|
| **GenieX** | **The runtime.** Loads the model, runs it on the NPU, and serves an OpenAI-compatible API at `http://127.0.0.1:18181/v1`. This is what's running during the demo. | sits on top of QAIRT; wraps llama.cpp too |
| **QAIRT** (Qualcomm AI Runtime) | The low-level engine that actually talks to the NPU. You never call it directly — GenieX does. | **current name** of the stack below |
| **QNN** / **Qualcomm AI Engine Direct** | The **former name of QAIRT**. Same lineage. Why docs look inconsistent. | old name, same thing |
| **SNPE** (Snapdragon Neural Processing Engine) | The older, separate SDK. Uses `.dlc` files. Not used here. | legacy sibling |
| **Qualcomm AI Hub** | Cloud **model catalog + conversion/quantization job service**. Where the model came from. Not a runtime. | upstream of GenieX |
| **QUAD** | **Build-time toolkit.** Detect hardware, convert models, profile on real silicon, compare NPU/GPU/CPU allocation. Delivered as an MCP server you drive from Claude Code. | wraps all of the above; **not** a runtime |
| **QUAD-Client** | The small local CLI that connects your machine to the hosted QUAD server (`quad.infra.foundries.io/mcp`) so no heavy SDK is installed locally. | client ⇄ QUAD server |
| **QAIRT Visualizer** | Desktop tool: model graph, **per-op execution time**, HTP analysis, source-vs-compiled op mapping. Shows *which* ops fell off the NPU. | inspects QAIRT artifacts |
| **ExecuTorch** (`.pte`) | PyTorch's on-device runtime. An alternative output format QUAD can target. Not used here. | — |
| **AIMET** | Qualcomm's quantization toolkit. Used indirectly, via AI Hub jobs. | — |

### Qualcomm silicon

| Term | What it is | This project's |
|---|---|---|
| **Snapdragon X Elite** / **X1E80100** | The laptop SoC — the actual chip name. | 12× Oryon, 31.6 GB RAM |
| **Copilot+ PC** | Microsoft's *branding tier* for PCs with a 40+ TOPS NPU. Not a chip. | same laptop, marketing name |
| **Hexagon** / **HTP** / **HTP0** | The **NPU**. "Hexagon Tensor Processor"; `HTP0` is how it appears in logs. All the same silicon. | Hexagon v73, 45 TOPS |
| **Adreno** | The **GPU**. | Adreno X1-85 |
| **Oryon** | The **CPU**. | 12 cores |
| **TOPS** | Trillions of operations per second — a marketing throughput number, not a benchmark. | — |
| **Snapdragon 8 Elite** | The Galaxy S25 Ultra SoC. Same GenieX story, different bundle. | stretch goal |

### The board

| Term | What it is |
|---|---|
| **Arduino UNO Q** | The single-board computer: a Linux side (Qualcomm **QRB2210**, brand name **Dragonwing**) *plus* a microcontroller (**STM32U585**) on one board. **No NPU** — AI on this chip runs on GPU/CPU. |
| **Modulino** | Arduino's plug-in sensor modules. On hand: **Buttons, Distance, Thermo** (I²C `0x3E` / `0x29` / `0x44`). There is no true leak sensor: **button C injects `leak_detected` on press and `leak_cleared` on release** — the live leak path. The **Distance** module now serves as a presence sensor (`object_entered`/`object_left` across 1000mm); its water-level leak role is **not currently reachable**, since `sensor_tick` no longer carries `distance_mm`. |
| **Qwiic** / **`Wire1`** | The 4-pin connector standard / the I²C bus the Modulinos sit on. Visible **only from the microcontroller sketch**, not from the Linux side. |
| **App Lab** | Arduino's tooling for running an app across the Linux + MCU halves. |
| **Tailscale** | Mesh VPN giving the board a stable hostname to reach the laptop, independent of hackathon WiFi. |

### Protocols and transport

| Term | Its one job |
|---|---|
| **MCP** (Model Context Protocol) | Standard by which an agent calls tools. A **client** calls tools on a **server**. |
| **stdio transport** | How Hermes launches and talks to our tool servers — a local subprocess over stdin/stdout. No network. |
| **Telegram Bot API** / **BotFather** / **`hermes gateway`** / **`/sethome`** | The phone channel: where you get a bot token, the daemon that bridges it, and the command that lets Hermes message you *first*. |

---

## 2. The five-layer stack

Bottom-up, with this project's occupant of each layer:

```
 transport   Telegram  (phone ⇄ laptop)                 ← the only cloud hop left
 agent       Hermes Agent  (Nous Research)              ← decides WHAT to do
 model       Qwen3-4B-Instruct-2507  Q4_0 GGUF          ← produces tokens
 runtime     GenieX  →  llama.cpp / QAIRT               ← makes the model run on silicon
 silicon     Hexagon NPU · Adreno GPU · Oryon CPU       ← does the math
```

Each layer only knows its neighbours. Hermes doesn't know what an NPU is; it speaks HTTP to an
OpenAI-shaped endpoint. GenieX doesn't know what a rack is; it turns prompts into tokens. That
separation is why swapping Ollama → GenieX was a config change rather than a rewrite.

Rendered as full wiring diagrams (including the sensor path) in
[ARCHITECTURE.md §1](ARCHITECTURE.md#1-runtime--what-runs-during-the-demo).

---

## 3. Build-time vs demo-time

**The most load-bearing distinction in this project.** These two sets of tools never run at the same
time, which is why QUAD touching the cloud does not compromise the on-device claim.

**Build-time** — before the demo, cloud allowed:

- **QUAD-Client → hosted QUAD MCP server** — nine tools exist, but only
  `profile_device_plan` + `profile_device_report` applied to our artifact. `profile_workload` and
  `profile_device` **cannot reach this laptop** (the QUAD server is a remote x86 VM with no Hexagon),
  and `convert_model` / `aihub_select` / `generate_code` are unnecessary for a prebuilt AI Hub
  bundle. Per-tool verdicts and the numbers they produced: [BENCHMARKS.md](BENCHMARKS.md)
- **Qualcomm AI Hub** — model download and quantize jobs
- **QAIRT Visualizer** — per-op profiling, CPU-fallback diagnosis
- **`quad-detect`** — the Day-1 go/no-go hardware check

**Demo-time** — on stage, no cloud LLM call:

- **`geniex serve --nctx 65536 --compute npu`** on `127.0.0.1:18181`
- **Hermes Agent** + its five MCP tool servers over stdio
- **UNO Q** sensor feed
- **Telegram** — the one genuine cloud hop, and it carries chat text only, never inference

### What QUAD is *not*

It is **not the inference server**, **not the agent**, and it **did not write the MCP tool code** —
that's hand-written TypeScript in [../mcp-tools/](../mcp-tools/). QUAD's job ends at *"model
converted, verified on the NPU, and profiled."* Full breakdown:
[HARDWARE_UTILIZATION.md § QUAD's role](HARDWARE_UTILIZATION.md#quads-role-in-this-project).
Diagrammed — with per-tool usage status — in
[ARCHITECTURE.md §3](ARCHITECTURE.md#3-build-time--quad-a-separate-graph-entirely).

---

## 4. One request, end to end

**Reactive path** — you ask *"what's the temperature in rack B1?"*

| # | Where | What happens | Local? |
|---|---|---|---|
| 1 | phone | you type into Telegram | — |
| 2 | Telegram servers | message relays | ☁ **cloud** |
| 3 | laptop, `hermes gateway` | receives it, assembles prompt + tool definitions | local |
| 4 | → `POST 127.0.0.1:18181/v1/chat/completions` | Hermes asks the model | local |
| 5 | GenieX → llama.cpp Hexagon backend | Qwen3 runs **on the NPU** | local |
| 6 | model output | returns `tool_calls` + `finish_reason: "tool_calls"` — it asks for a tool, it does not invent a number | local |
| 7 | Hermes → environmental MCP server (stdio) | dispatches the call | local |
| 8 | environmental server | reads the sensor log pushed from the UNO Q | local |
| 9 | back to step 4 | result re-enters the model as context; now it answers in words | local |
| 10 | Telegram | reply to your phone | ☁ **cloud** |

**Steps 3–9 are the product.** Cut the WiFi and they all still work — which is exactly the scoped
demo beat: query the agent *on the laptop*, not through Telegram, since Telegram is the one piece
that genuinely needs the internet.

**Proactive path** — nobody asked anything:

```
hermes cron (every 5m, --no-agent)  → environmental-watch.py → check-environmental.js
   → getEnvironmentalReading()  (the SAME source module the MCP server uses, imported
                                 directly — this path does NOT go through the MCP server)
   → newest line of the pushed UNO Q sensor log
   → decide-alert  (edge-triggered: fire on crossing, not every poll; cooldown; recovery)
   → prints a message ONLY if warranted  → Telegram push to your phone
```

No LLM is involved in a tick: the script decides, Hermes just relays stdout. That is why the
5-minute cadence doesn't compete with interactive queries for the NPU.

Same components, no incoming message. This is the path that confuses people, because the trigger is
a clock rather than a human.

---

## 5. Easily confused pairs

**QUAD vs GenieX** — the big one. QUAD is the build-time toolkit that *measures and converts*;
GenieX is the runtime that *serves the model on stage*. If something is running during the demo,
it's GenieX. If it produced a number in a report, it was QUAD.

**QAIRT vs QNN vs SNPE** — QAIRT is the current name; QNN / "AI Engine Direct" is the **former name
of the same stack**; SNPE is the older separate SDK (`.dlc` files) that we don't use. Three names,
one lineage — this is why the vendor docs feel contradictory.

**GenieX's two internal runtimes** — GenieX can run a model two ways, and which one you get changes
what works:

| | `qairt` path | `llama.cpp` path ← **ours** |
|---|---|---|
| Model format | AI Hub bundle (`W4A16`) | GGUF (`Q4_0`) |
| Context | fixed **4K** | **64K** (`--nctx 65536`) |
| Tool calls | ❌ not parsed | ✅ proper `tool_calls` |
| Role here | benchmark / demo beat only | **drives Hermes** |

Per [NPU_SPIKE_RESULTS.md](NPU_SPIKE_RESULTS.md). Hermes needs 64K *and* tool calls, so only the
right-hand column can be the brain.

**Q4_0 vs Q4_K_M** — both are 4-bit GGUF quantizations and they look interchangeable. They are not:
**Q4_K_M silently falls back to the CPU** (56–74% CPU load) while **Q4_0 engages Hexagon** (12–17%).
No error is raised. The quantization label is the difference between your NPU claim being true and
being false — re-check it after *any* model swap.

**AI Hub vs GenieX** — AI Hub is the cloud catalog and conversion-job service; GenieX is the local
runtime. AI Hub is where the model comes *from*; GenieX is what *runs* it.

**MCP client vs server — and the two separate graphs.** A client calls tools on a server. This
project has **two MCP setups that never touch each other**:

```
graph 1 (build-time)   Claude Code ──────► QUAD MCP server        (hosted)
graph 2 (demo-time)    Hermes Agent ─────► network / storage / compute / environmental
                                            (our stdio servers)
```

So "the MCP server" is ambiguous in these docs — it means different things depending on the graph.
Note especially: **QUAD is an MCP server for Claude Code, not for Hermes.** Hermes never talks to
QUAD.

**Hermes Agent vs SMH-Hermes vs Hermes LLMs** — Nous's agent runtime / this repository / Nous's
*model* family. We use the runtime and this repo; we do **not** use their models. The brain is Qwen3.

**Copilot+ PC vs Snapdragon X Elite** — Microsoft's branding tier (requires a 40+ TOPS NPU) vs the
actual SoC. One laptop, two names.

**Hexagon vs Adreno vs Oryon** — NPU, GPU, CPU respectively. When a doc says "it fell back to CPU",
it means the work left Hexagon for Oryon.

**Telegram vs MCP** — both carry messages, opposite directions and purposes. Telegram is the
**outbound human channel** (agent ⇄ you). MCP is the **inbound tool channel** (agent ⇄ data).

**QRB2210 vs QCS2210** — the UNO Q's Linux SoC. QUAD's own `quad-unoq` skill calls it QCS2210;
Arduino and Qualcomm call it QRB2210. A vendor naming mismatch, not two different boards.

**Logged precision vs reported precision** — the board's log holds raw Modulino floats
(`25.081483840942383`); everything the system *sends* is cut to **one decimal** (`25.1`). The cut
happens once, at ingestion, in [`mcp-tools/src/common/round.ts`](../mcp-tools/src/common/round.ts) —
so the number the agent reasons on, the number a threshold is compared against, the number in the
Telegram alert and the number on the wall are all the same number. Rounding per-display instead
would let a `Temperature 30.0C` alert carry an `ok` badge computed from a raw 29.96. Full detail:
[mcp-tools/README.md](../mcp-tools/README.md#one-decimal-place-applied-on-the-way-in).

---

## Where to go next

| You want | Read |
|---|---|
| What's done and what's next | [../PROGRESS.md](../PROGRESS.md) |
| **Test the whole chain, board → phone** | **[E2E_TEST.md](E2E_TEST.md)** |
| The finalized architecture and why | [HARDWARE_UTILIZATION.md](HARDWARE_UTILIZATION.md) |
| Proof the NPU path actually works | [NPU_SPIKE_RESULTS.md](NPU_SPIKE_RESULTS.md) |
| Measured NPU numbers (per-op, prefill/decode) | [BENCHMARKS.md](BENCHMARKS.md) · method: [BENCHMARK_PLAN.md](BENCHMARK_PLAN.md) |
| Which claims survived scrutiny | [AUDIT_2026-08-03.md](AUDIT_2026-08-03.md) |
| How the board was set up | [UNOQ_SETUP.md](UNOQ_SETUP.md) |
| The original pitch (historical) | [REQUIREMENTS.md](REQUIREMENTS.md) · [FEASIBILITY.md](FEASIBILITY.md) |
