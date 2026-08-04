# Response to the GPT improvement plan — engineering + data-science review

Reviewing [gpt_model_feedback.txt](gpt_model_feedback.txt) against what is actually built, actually
measured, and actually achievable in the time left. Written to be decided on, not admired: every
item is **Accept / Accept with change / Reject**, with the reason.

**Bottom line.** The *positioning* half of the plan (§1–4, §9–10, §16–21, §26–29) is right and should
be adopted almost verbatim — it is the single highest-value change available and costs no code. The
*implementation* half (§11–15, §24–25) is where it breaks: it assumes an LLM latency budget we do
not have, and it assumes correlated telemetry we have not built. Adopting it as written would
produce a demo that is slower, and a correlation story that is **statistically fictional**.

Three corrections carry most of the value:
1. **Compute the numbers in the tools, not the model.** Everything GPT wants the LLM to produce
   (risk, confidence, evidence, timeline) must be computed deterministically in TypeScript and
   *narrated* by the LLM. Otherwise the demo does not fit in its time slot.
2. **Couple the simulators before claiming correlation** — or say plainly that you cannot.
3. **Tie confidence to data freshness.** We already have the mechanism, and it turns this morning's
   failure into a feature.

---

## 1. What GPT got right, and what it did not know we already have

Right, adopt as-is: reposition from "sensor monitoring" to **on-device incident triage**; Arduino is
a *rack simulator*, not the innovation; never claim full offline (Telegram is a cloud hop); name the
mocks "simulated telemetry adapters" and disclose them; add a governance/safety section; separate
risk from confidence; "observe → explain → recommend → human approves".

Already built — GPT assumed these were missing:

| GPT asks for | Status |
|---|---|
| §11 "don't alert on one weak signal"; cooldown | ✅ **Built** — `decide-alert.ts` is edge-triggered with cooldown + one-shot recovery. Fires on *crossings*, not every poll |
| §6 honest mock labelling | ✅ **Built** — every fallback carries `fallbackReason`; the 09:36 alert said *"(mock data: sensor log is stale… board may be offline)"* verbatim |
| §24 `last_sensor_age_seconds` | ✅ **Built** — `UNOQ_LOG_MAX_AGE_S=180` staleness guard, degrades to mock rather than reporting stale as real |
| §17 read-only, no destructive actions | ✅ **True today** — all four tools are read-only by construction |
| §7 "not just read sensor → send alert" | ⚠️ Partly — edge logic exists, correlation does not |

So the honest framing is *"we already refuse to cry wolf"* — a stronger claim than GPT realised, and
one we can demonstrate.

---

## 2. The four problems with the plan as written

### P1 — The latency budget makes LLM-computed scoring infeasible

Measured on this machine: decode **~15–16 tok/s**, prefill ~280 tok/s, **no prompt caching**
(`cache_prompt` honoured ~18%), so every agent iteration re-prefills the whole conversation →
**~2–4 minutes per iteration**, and each tool call is another iteration.

GPT's §9 demo is 6 steps, several with follow-up questions. At 2 tool calls per answer that is
3 iterations ≈ **6–12 minutes *per question***. The scripted demo does not fit in any hackathon slot.

**Fix:** the LLM must do exactly one thing — turn a prepared JSON verdict into two sentences. Risk
score, confidence, evidence list and timeline are **pure functions of telemetry** and belong in
TypeScript, where they cost ~0 ms and are unit-testable. Target **one tool call per demo question**,
`max_tokens` capped, answers ≤ 80 tokens.

This also fixes a scoring problem: a number the model *invents* is not reproducible; a number the
tool *computes* is the same every time a judge asks.

### P2 — Uncoupled simulators make the correlation story fictional

The plan's centrepiece (§8 Workflow 2, §25 Scenario 1) is "temperature rose, *then* storage latency
rose, therefore cooling degradation". Our mocks are **independent random generators** — storage
returns a fresh random `failureRisk`/`capacityUsed` per call with no reference to temperature.

So today that narrative is a coincidence we would be manufacturing on stage. If a judge asks *"show
me that again"*, the second run will not reproduce it. Worse, it is the exact claim a technical judge
will probe.

**Fix (~2h, the highest-value code change on this list):** make the simulated telemetry a **function
of the physical state**. A deliberately simple, disclosed transfer function:

```
storage_latency_ms   = base + k1 · max(0, temp_c − 26)        # thermal throttling
backup_throughput    = nominal · (1 − k2 · max(0, temp_c − 26))
packet_loss_pct      = base                                    # deliberately NOT coupled
```

Then the correlation is real, reproducible, and the *absence* of network coupling is what lets Hermes
correctly rule network out — which is Scenario 2 and Scenario 4. **Say the transfer function out
loud**: "our simulator couples thermal to storage the way real thermal throttling does; network is
independent, which is why Hermes does not blame the network."

Without this, drop the RCA workflow rather than fake it.

### P3 — "87/100" and "81% confidence" are false precision

Two distinct statistical errors in §12–13:

**(a) Additive weights double-count a single root cause.** Temperature +25, storage latency +25,
backup delay +20 — but under the coupling above, those are *one* event observed three times. The
score inflates precisely when the signals are most redundant. A stats-literate judge will ask "are
those independent?" and the honest answer would be "no".
**Fix:** score by **independent signal family** (physical / storage / network / compute), not by
individual metric, with the first signal in a family scoring full and subsequent ones with
diminishing weight. Cap contributions per family.

**(b) A percentage confidence implies calibration we cannot support.** We have no labelled incidents,
no validation set, no way to say "81% means it is right 81% of the time". Emitting that number is the
one thing a data scientist should refuse.
**Fix:** either report **ordinal** confidence (High / Medium / Low) with the reason, or if a number is
wanted, define it as an explicitly non-probabilistic **agreement index** and label it as such:
`agreement 3/4 families`. Never call it probability.

Present the risk score as a **transparent, rule-based severity index** — its virtue is that it is
inspectable and reproducible, not that it is learned.

### P4 — "Cost of ignoring" is a forecast with no model

§8 Workflow 3 predicts what happens in 30 minutes. We have no historical incidents, no fitted model,
no baseline drift estimate. Presented as prediction, it is speculation with a confident voice — the
exact failure mode that makes AI ops tools untrusted.

**Fix:** reframe as a **stated-assumption scenario**, and show the assumption:
> *"If the current +1.2 °C/min trend continues and the coupling holds, storage latency reaches the
> 60 ms SLA threshold in ~18 minutes. This is a linear extrapolation of the last 5 minutes, not a
> learned forecast."*

That is defensible, still impressive, and computable from the sensor log we already keep.

---

## 3. My addition — confidence should collapse when the data is stale

Not in GPT's plan, and it is the most demo-able integrity feature we have.

At 09:36 today the watchdog fired **CRITICAL — 38.95 °C, 90.19 %** built entirely on mock data,
because the board had been offline for 10.7 hours. It labelled itself honestly, which is good — but
the *severity was unchanged* by the fact that the inputs were invented.

Confidence must be a function of provenance:

```
confidence = f(source, age, agreement)
  source = "unoq-log" and age < 180s   → High
  source = "unoq-log" and age > 180s   → Low        (stale)
  source = "mock"                      → "no confidence — simulated input"
  contradicting family present         → downgrade one level
```

Then Hermes says: *"Risk High, **confidence none — this reading is simulated because the sensor has
been offline for 10.7 hours**"*. That single behaviour demonstrates the judgement GPT's §26 says
judges want, is ~30 lines of code, and turns our worst failure of the week into the strongest
trust story in the demo.

---

## 4. Section-by-section verdict

| § | Proposal | Verdict | Note |
|---|---|---|---|
| 1–4 | Reposition as on-device AI Operations Engineer; Arduino = rack simulator | ✅ **Accept** | Free, highest value. Do first |
| 5 | Sensor reframing (thermal / obstruction / injectors) | ✅ Accept | Wording only |
| 5 | Button A=power, B=network, C=leak | ⚠️ **Change** | Code maps A/B/C → `door_open`/`light_on`/`leak_detected`. Renaming touches sketch + `file-source.ts` + tests. Cheap but not free — do only if buttons A/B appear in the demo |
| 6 | "Simulated enterprise telemetry", disclose | ✅ Accept | Already our stance; adopt the wording |
| 7 | Observe→Correlate→Prioritize→Explain→Recommend | ✅ Accept as narrative | Correlate needs P2 fixed |
| 8 W1 | "Should I care?" | ✅ Accept | Best workflow. Compute in tool |
| 8 W2 | Root-cause analysis | ⚠️ **Blocked on P2** | Fictional until simulators are coupled |
| 8 W3 | Cost of ignoring | ⚠️ **Change** | Label as extrapolation + assumptions (P4) |
| 8 W4 | Explain reasoning | ✅ Accept | Cheap — narrate the evidence list |
| 8 W5 | Proactive correlated alert | ✅ Accept | Extends existing watchdog |
| 9 | 6-step demo story | ⚠️ **Change** | Excellent structure, **will not fit in time** (P1). Cut to 3 live questions + prepared fallback |
| 10 | What not to focus on | ✅ Accept | Agrees with our own notes |
| 11 | Escalate only on multiple signals | ✅ Accept — **partly built** | `decide-alert` already edge-triggered; add multi-family rule |
| 12 | Risk score, additive weights | ⚠️ **Change** | Double-counts (P3a). Score per family |
| 13 | Confidence separate from risk | ✅ **Accept, strengthen** | Ordinal, not %; tie to freshness (§3 above) |
| 14 | Incident timeline | ✅ **Accept — best effort/impact ratio** | We already log timestamped events; pure function, no LLM |
| 15 | Evidence pack | ✅ Accept | Structure the tool output this way |
| 16–17 | Human approval, governance | ✅ **Accept** | Doc-only, high credibility. Already read-only |
| 18 | Rename components | ✅ Accept | Wording |
| 19–21 | README/architecture wording | ✅ Accept | Fold into existing docs |
| 22 | Short demo prompts | ✅ Accept | Mandatory given P1 |
| 23 | Sample responses | ✅ Accept as output contract | Make the tool emit these fields |
| 24 | Telemetry fields | ⚠️ **Scope** | We have `latencyMs`, `packetLossPct`, `capacityUsed`, `failureRisk`. Backup metrics and compute thermal flags **do not exist yet** |
| 25 | 4 incident scenarios | ✅ Accept | Scenario 4 (workload spike ≠ incident) is the one that proves judgement — keep it |
| 26–29 | Judge framing, title, one-liner | ✅ Accept | Recommend title: *Hermes: On-Device AI Operations Engineer* |
| 30 | Don't add technology | ✅ **Accept emphatically** | Everything above is TypeScript in existing servers |

---

## 5. What is actually left to build

Ordered by (judge value ÷ hours), assuming the demo is days away and the board must come back online
first. Nothing here adds a new technology, per §30.

| # | Item | Hours | Why it earns its place |
|---|---|---|---|
| 0 | **Board back online** + `pull_sensor_log.ps1` over USB | 0.5 | Everything physical is dead without it. Blocking |
| 1 | **Reposition all docs + pitch** to "AI Operations Engineer" | 1 | Free marks; changes how everything else is heard |
| 2 | **Couple the simulators** to physical state (P2) | 2 | Makes correlation real and reproducible. Unblocks W2/W5 |
| 3 | **Risk + confidence engine** in TS (per-family, ordinal confidence, freshness-aware) | 2–3 | The core "Hermes judges, not reports" claim |
| 4 | **Evidence pack + timeline** as tool output | 1–2 | Deterministic, no LLM cost, judges love timelines |
| 5 | **New tool `get_incident_assessment`** returning the whole verdict in one call | 1 | **The P1 fix** — one tool call per question instead of four |
| 6 | Correlated Telegram alert format | 0.5 | Extends the working watchdog |
| 7 | Governance/safety section in README | 0.5 | Pure credibility, zero risk |
| 8 | Rehearse ×3 with prepared fallbacks | 2 | Latency makes live demo fragile |

**Deliberately not doing:** button A/B remap unless they appear on stage; `%`-confidence; a learned
forecast; any new runtime or model.

---

## 6. Judge answers I would change

GPT's §27 answers are good but two would fail a follow-up:

**"Is the infrastructure data real?"** — GPT's answer says telemetry is "simulated using realistic
data patterns". A judge may then ask *"so how did it correlate temperature with storage?"* Answer
honestly and specifically:
> *"The environmental path is live from the board. Storage and network are simulated — and the
> simulator deliberately couples storage latency to rack temperature the way thermal throttling does,
> while leaving network independent. That coupling is what Hermes detects, and it is why it correctly
> rules out the network. The MCP adapters can be swapped for real DCIM/SNMP without touching the
> reasoning layer."*

**"How confident are you?"** — never answer with a percentage. Answer:
> *"Confidence is ordinal and provenance-driven: High only when the sensor is live and under 3
> minutes old and at least two independent signal families agree. Right now the board is live, so
> High. If the sensor goes stale, Hermes drops to 'simulated input — no confidence' rather than
> quietly inventing a number."*

That answer is the difference between a demo and a system someone would let near production.
