# Positioning — the approved wording

The exact sentences to use, so the README, the slides, the demo script and the Q&A answers all
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

### Where the model earns its keep

If asked "isn't the LLM just a narration layer over deterministic plumbing?" — the honest answer
is that the deterministic floor is a **safety property, not the absence of AI**, and the model
does four jobs the plumbing cannot:

1. **Tool orchestration** — for an open-ended question the agent decides which adapters to
   consult and in what order; the one-call assessment exists as an optimization of that loop,
   not a replacement for it.
2. **Receipts and narrated diagnosis** — every verdict arrives as an explanation with evidence
   attached, written by the model from live tool outputs, not filled into a template.
3. **Live Q&A** — the on-call interrogates the incident in free text from the phone and gets
   answers grounded in current tool state; no rule engine answers questions it wasn't shaped for.
4. **A second, smaller intelligence at the edge** — the UNO Q's on-board SmolLM2 labels activity
   patterns before they reach the laptop; the wall and Telegram surface its inferences.

The risk/confidence arithmetic stays deterministic **on purpose**: numbers a reviewer can
recompute are the part you want falsifiable. The model reasons; the arithmetic keeps the
reasoning honest.

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
Physical Signal Layer     Arduino UNO Q — temperature, water level (ToF), presence, door, buttons
Telemetry Layer           Simulated storage / network / compute adapters
MCP Tool Layer            Five stdio servers — the swappable seam to real systems
Reasoning Layer           Hermes Agent + Qwen3-4B-Instruct-2507 on the Hexagon NPU via GenieX
Decision Layer            Risk (severity index) + confidence (ordinal) + evidence + recommendation
Authorization Layer       Access verdict + human approve/deny — LOCAL ONLY, never over the relay
Notification Layer        Messaging gateway — Telegram today, Slack/Teams in an enterprise
```

The Authorization Layer sits **below** Notification on purpose. The relay may carry the question;
it may never carry the answer.

## 7. Q&A — scripted answers

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
>
> And "human approves" is a **mechanism, not a posture** — there is an approval surface on the
> on-call's phone, decisions are recorded with who and when, and a recorded decision cannot be
> silently overwritten. *(It was an empty promise until 2026-08-05; an independent review caught
> that, and it is worth saying so if asked how we know.)*

**"Who is standing at the rack?"**
> The board's presence and door sensors open a challenge, and the system reasons about identity
> **in context** — an unknown person is one thing; an unknown person during a live incident is
> worse than either alone; two faces against one authorised door entry is tailgating, which is the
> canonical way someone reaches a rack they should not. The interesting case is the quiet one: a
> *known* engineer on site during an incident means the on-call is already responding, so we
> **stop paging them.** That is the only rule in the system that makes it quieter.

**"Is that face recognition?"**
> Yes, now — and I want to be precise about what that covers. `face-cpu` is live: InsightFace's
> **buffalo_s** bundle — an SCRFD-500MF detector and an ArcFace MobileFaceNet recognizer, both
> ONNX — running entirely on the laptop's **CPU** via onnxruntime. Deliberately not the NPU: Phase
> A targets CPU because it's deterministic and stable inside a 24-hour ship window; the NPU rung,
> `face-npu`, is the adapter's next step and is **not built**. The badge rung, `qr-badge`, also
> isn't claimed — it has no real credential behind it.
>
> The match threshold is `ACCESS_MATCH_THRESHOLD=0.43`, and I'll say plainly it's **provisional**
> — measured 2026-08-06 on a 3-person roster enrolled from laptop-webcam photos (genuine matches,
> n=23, minimum cosine similarity 0.7702; impostor pairs, n=46, maximum cosine similarity 0.1026;
> threshold set at the midpoint, rounded down). We validated it live the same day against
> phone-camera captures — known people scored 0.85 and 0.79, comfortably clear of the line — but
> n is small, and the threshold needs re-measuring against any larger roster before it means more
> than "worked for us this week."
>
> There is also **no liveness detection** — a printed photo of an enrolled face could pass a
> match today. That's why the design doesn't stop at the match: every non-match still falls to a
> human, on the phone or from the wall's approval panel, which shows the captured photo so the
> decision is informed rather than a rubber stamp. The system is human-supervised throughout, by
> design, not as a stopgap for what isn't built yet.
>
> The roster stores **embeddings, never images** — the source photo is discarded once a match is
> resolved, and a photo held for a human decision lives in memory only, never on disk, dropped the
> moment the decision lands. You cannot reconstruct a face from the roster file, which is why it's
> safe to open it on stage. GDPR treats face templates as special-category data, so keeping them
> on-device — and never persisting the source image — is what a privacy impact assessment wants to
> see, materially easier to deploy and defend than shipping staff biometrics to someone else's GPU.
> InsightFace's pretrained models are released for **non-commercial research purposes only**,
> which is the license this project runs under.

**"Why Arduino?"**
> It is our physical rack simulator. Real datacenters have DCIM and BMS; we needed something an audience
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
