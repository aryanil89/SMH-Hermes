# Positioning — the approved wording

The exact sentences to use, so the README, the slides, the demo script and the judge answers all
say the same thing. Copy from here; do not improvise on stage.

Every claim below has been checked against the locked decisions in [../PROGRESS.md](../PROGRESS.md)
and [FEASIBILITY.md](FEASIBILITY.md) §Telegram. Nothing here overstates what is built.

---

## 1. Title and one-liner

**Title**

> **Hermes: On-Device AI Operations Engineer**

**One-liner** — leads with what is unusual (the intelligence is local), not with the stack:

> Hermes is an AI operations engineer that runs entirely on a Snapdragon X Elite — no cloud AI, no
> data leaving the laptop. It correlates real physical sensor signals with infrastructure telemetry
> to tell an on-call engineer what is wrong, why it matters, and what to do next.

**One-sentence version** for a badge or a slide footer:

> A private, on-device infrastructure triage agent for datacenter operations.

## 2. What Hermes is — and is not

> **Is:** a local reasoning layer over signals an ops team already has. It correlates, prioritises,
> explains, and recommends.
>
> **Is not:** a replacement for monitoring systems, DCIM, or sensors. Datacenters already have
> those. Hermes does not collect the signals — it *judges* them.

The distinction to hold on to: **the innovation is reasoning over signals, not collecting them.**

## 3. The offline claim — say it precisely

This is the word that wins or loses credibility. The strongest *true* version is very strong; the
obvious version is false. Do not drift up this ladder under pressure.

| | Claim | Status |
|---|---|---|
| ✅ **Lead with this** | "The intelligence is offline. The model, the reasoning, the tool calls and the sensor path all run on the Snapdragon — no cloud AI service is contacted, ever." | **True, and provable on stage**: cut the WiFi and ask a question |
| ✅ Also true | "Offline-first. The only thing that touches the internet is the notification hop — and that is a message relay, not intelligence." | True — disclose it plainly, early, unprompted |
| ✅ Also true | "The notifier is a swappable adapter, not an architectural commitment. We demo on Telegram because it provisions in two minutes; the same gateway config already carries **Slack, Teams, Discord, WhatsApp and Signal**. An ops team points it at whatever they already live in — nothing above the gateway changes." | **True** — `platform_toolsets` entries for all six exist in the live Hermes config |
| ⚠️ Careful | "Because the cloud dependency is confined to one swappable adapter, an air-gapped site could point it at an on-prem relay without touching the reasoning layer." | Architecturally true — but say **could**, and volunteer that we have only tested Telegram |
| ❌ **Never** | "Fully offline / air-gapped end to end." | **False.** The Telegram Bot API needs internet. Forbidden by our own locked decision |

The reframe that matters: **the cloud hop is a deployment choice at the edge of the system, not a
property of the intelligence.**

## 4. Honest disclosure — say this once, early, unprompted

> For the demo, network, storage and compute telemetry are simulated with realistic data patterns.
> The environmental path is live from the Arduino board. The MCP adapters are the seam — the same
> tools can be pointed at real DCIM, BMS or SNMP without touching the reasoning layer.

Volunteering this is worth more than being caught by it. And it is now backed by evidence: we
**measured our own simulator's false-positive rate** and recalibrated it from 68.7% of calls
reporting a CRITICAL down to 8.5%, so a healthy baseline is genuinely healthy — see
[REVIEW_3_2026-08-04.md](REVIEW_3_2026-08-04.md) §2. Very few teams can say they measured their
own fixture.

## 5. Component names

Rename in slides, README and speech. The new names disclose the mock/real split by themselves.

| Say | Not |
|---|---|
| Simulated Network Telemetry Adapter | mock network |
| Simulated Storage Telemetry Adapter | mock storage |
| Simulated Compute/Grid Adapter | mock compute |
| **Physical Environmental Adapter** (live) | the Arduino thing |
| Messaging gateway (Slack / Teams / Telegram / …) | "a Telegram bot" |
| Incident correlation + risk scoring | "the alert logic" |
| Physical rack simulator | "our sensors" |

**Never** call the notification layer "Telegram" as though it were the architecture. It is one
adapter, currently selected.

## 6. Architecture, in layers

```
Physical Signal Layer     Arduino UNO Q — temperature, water level (ToF), incident buttons
Telemetry Layer           Simulated storage / network / compute adapters
MCP Tool Layer            Four stdio servers — the swappable seam to real systems
Reasoning Layer           Hermes Agent + Qwen3-4B-Instruct-2507 on the Hexagon NPU via GenieX
Decision Layer            Risk (severity index) + confidence (ordinal) + evidence + recommendation
Notification Layer        Messaging gateway — Telegram today, Slack/Teams in an enterprise
```

## 7. Judge Q&A — scripted answers

**"Datacenters already have sensors. What is new?"**
> Correct, and we do not claim otherwise. The sensors are not the contribution — the local reasoning
> layer is. Hermes correlates physical signals with storage, network and compute telemetry to say
> what matters, why, and what to do, on-device.

**"Is it really offline?"**
> The intelligence is. The model, the reasoning and the tool calls never leave this laptop — I can
> prove it by pulling the WiFi and asking a question right now. The one thing that needs internet is
> the notification hop to the phone, and that is a message relay, not intelligence.

**"So why does Telegram need internet?"**
> Because it is a hosted messaging service — that is the trade for a phone notification that just
> works. It is also a swappable adapter: the same gateway speaks Slack, Teams, Discord, WhatsApp and
> Signal. In a real deployment you would point it at whatever your ops team already uses.

**"Could this run in a secure facility?"**
> Architecturally yes — the cloud dependency is confined to that one adapter, and everything above it
> is already local. Being straight with you: we have only tested Telegram, so I would call that a
> supported path rather than a demonstrated one.

**"Is the infrastructure data real?"**
> The environmental path is live from the board. Storage, network and compute are simulated — and the
> simulator deliberately couples storage latency to rack temperature the way thermal throttling does,
> while leaving network independent. That coupling is what Hermes detects, and it is why it correctly
> rules out the network. One zone is instrumented and the other is a control, so "the hot zone
> degraded and the cold one didn't" is evidence rather than assertion.

**"How confident is it?"**
> Confidence is ordinal and provenance-driven, never a percentage — we have no labelled incident set,
> so a number like "81%" would be false precision. It is High only when the sensor is live, under
> three minutes old, and the pattern discriminates between causes. If the sensor goes stale, Hermes
> says "simulated input — no confidence" instead of quietly inventing a reading.

**"Can it take action automatically?"**
> No, by design. Observe → explain → recommend → human approves → act. All four tools are read-only
> by construction. For infrastructure, that is a feature.

**"Why Arduino?"**
> It is our physical rack simulator. Real datacenters have DCIM and BMS; we needed something a judge
> can interfere with in the room. It is also the only input in the system you can falsify by hand —
> put your hand near the sensor and watch the reading move.

## 8. Where each string goes

| String | Destination |
|---|---|
| Title (§1) | Slide 1, README H1, submission form |
| One-liner (§1) | README opening paragraph, slide 1 subtitle |
| Is / is not (§2) | Slide 2, README "What Hermes is" |
| Offline ladder (§3) | Demo narration + Q&A card. **Not** a slide — it is a speaking discipline |
| Disclosure (§4) | Said aloud during the telemetry step; also README |
| Component names (§5) | Everywhere — slides, README, speech |
| Layers (§6) | Architecture slide; complements [ARCHITECTURE.md](ARCHITECTURE.md) §1 |
| Q&A (§7) | Printed card, one per team member |
