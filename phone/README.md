# phone

Samsung Galaxy S25 Ultra — Snapdragon 8 Elite (SM8750-AC), 12 GB RAM, Android 15 / One UI 8.

There is no app to build. The phone runs two things, both served from the laptop:

1. **Telegram** — the notification channel. One swappable adapter among six the gateway
   already carries (Slack, Teams, Discord, WhatsApp, Signal); see
   [../docs/POSITIONING.md](../docs/POSITIONING.md) §3.
2. **The access terminal** — `http://<laptop>:7788/phone.html`. Live rack status, the camera
   capture for an access challenge, the Approve / Deny control, and roster enrolment.

## Ask something, and you hear back twice

An answer takes 60–300 s here — full-prompt re-prefill on every model call, no KV cache. The
laptop can see that work happening. The phone could not: Hermes runs non-streaming against
GenieX, so until the answer landed there was nothing, and *thinking*, *wedged* and *dead* all
looked the same from a pocket. Telegram's `typing…` bubble does not close that gap — it expires
between refreshes and never reaches the notification shade, which is where a phone is actually
read.

So the gateway answers twice:

```
> what's the temperature in rack B1?
  Pulling the temperature data from rack B1 now — about a minute.     (~2 s, italic)
  Rack B1 is 22.4 °C, humidity 41%, source: real (sensor age 12 s).   (~60 s, plain)
```

The receipt is one line from the same local model — it names what you asked, so it could only be
a reply to *this* message, and it carries a wait estimate learned from that session's own
measured turns. Italic, because on a phone the difference between a receipt and an answer has to
survive a glance at a notification.

It states no findings, ever: it is written before a single tool has run, so it says only what is
starting. And it goes out even when the model is down — canned, but sent — which turns the old
unanswerable *"did it hear me?"* into *"it heard me and could not answer"*. Design and limits:
[../hermes-hooks/README.md](../hermes-hooks/README.md).

## Why the phone is the authorisation surface

The project's stated posture is *observe → explain → recommend → **human approves** → act*
([../docs/POSITIONING.md](../docs/POSITIONING.md) §7). Until this page existed there was no
approval mechanism at all, so that fourth step described something the system could not do.

An on-call engineer acknowledges from their phone — not from a button on the rack they may be
nowhere near. So the phone owns consent.

**The notification is cloud; the decision is not.** When a challenge needs a human, Telegram
carries the alert — and the message says so in its own last line: *"Approve or deny on the
access terminal. This message cannot authorise entry."* The authorisation happens on the local
page over the tailnet, because a third-party message relay is not somewhere physical datacenter
access should be granted from. Same layering argument as the swappable notifier, applied to
consent.

Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` to enable it. Unset — the default — it is a
silent no-op, and nothing in the access loop depends on it. The send is fire-and-forget with a
5s timeout and is never awaited by a render path: during the WiFi-off demo beat it *will* fail,
and that failure has to be invisible.

### The other direction: a known responder silences the pager

If the person at the rack is **on the roster** and an incident is already live, the verdict is
`expected` and the environmental watchdog **withholds the page** — you are standing in front of
the thing it would have told you about. It is a deferral, not a cancellation: walk away and the
alert arrives, marked *"held while the on-call was on site; sending now."* Escalation while you
stand there pages anyway. Details in [../docs/DASHBOARD.md](../docs/DASHBOARD.md) §Access.

## Running it

The access terminal is part of the dashboard server — no separate process:

```powershell
cd mcp-tools
npm install; npm run build     # once
npm run start:dashboard
```

Then open `http://<laptop-address>:7788/phone.html` on the phone. Bind the server somewhere the
phone can reach it — the **Tailscale interface address**, not `0.0.0.0`:

```powershell
$env:DASHBOARD_HOST = "100.x.y.z"   # the laptop's tailnet address
npm run start:dashboard
```

`0.0.0.0` on venue WiFi would expose the sensor log, the file paths and the Telegram text to
everyone on the network. The tailnet is WireGuard point-to-point and does not.

**Set a shared secret whenever you bind off loopback.** The read paths are a display; the write
paths are an access-control system, and `/api/access/enroll` is the sharpest edge — the roster
is what every later decision trusts, so anyone who can reach the port could enrol themselves and
then have their own capture read as `known`:

```powershell
$env:ACCESS_SHARED_SECRET = "pick-something"
```

Then open `…/phone.html?secret=pick-something` on the phone. The server prints a warning at
startup if you bind to a network without one. It is one lock on one door, not an auth system.

**To get that URL onto a phone** — a new phone, a closed tab, or a bookmark saved without the
query string — run `scripts\show-phone-link.ps1` on the laptop. It resolves the tailnet
host, appends the key, copies the link to the clipboard, and verifies the key against the running
server first.

That verification exists because of a failure that is genuinely hard to diagnose in the moment:
**a phone holding a key from before the last restart looks fine.** Nothing on the page reads the
key until a write, so the green `live` dot, the rack verdict and the SSE feed all work — and the
first sign of trouble is `Capture rejected` after someone has already taken the photo, which
reads as a broken camera. The script asks the server directly and answers in one line.

**Worked when:** the page shows a green `live` dot, the rack verdict tracks the wall, and
pressing Approve on a challenge changes the laptop wall within a second.

A new capture or approval prompt scrolls itself into view the moment it appears, so a person
scrolled down at the enrol section still sees it. It only fires on that transition — not on
every SSE tick — so it never fights someone mid-scroll on their own phone.

## Capture works over plain HTTP, on purpose

The camera is opened with `<input type="file" accept="image/*" capture="environment">`, not
`getUserMedia`. `getUserMedia` requires a secure context, which `http://<lan-ip>` is not — so a
live-video design would have needed a TLS certificate on the tailnet before it could work at
all. The file-input path opens the phone's own camera app, needs no permission dialog, no
HTTPS, and no secure context. It costs one extra tap and removes the single largest technical
risk in the feature.

Frames are downscaled to 960px in-page before upload, so a 200MP capture does not become a
multi-megabyte POST over a phone hotspot.

## Privacy — what is and is not stored

| | |
|---|---|
| Sent to the laptop | a downscaled JPEG, per capture |
| Kept after a **match** | a numeric embedding **only** — the photo is discarded immediately |
| Held for an **unmatched** capture | the JPEG, **in memory only**, until a human decides |
| Ever written to disk | never — matched or not |

A **matched** capture is resolved to a numeric embedding and the source photo is discarded on the
spot; `mcp-tools/.state/roster.json` never sees the image, only floats. An **unmatched** capture
is different on purpose: since a human now has to make the call, the photo is held in memory (see
[../docs/DASHBOARD.md](../docs/DASHBOARD.md) `GET /api/access/pending-photo` — unauthenticated,
like the other read-only GET routes) so it can be shown on the wall's approval panel alongside the
Approve/Deny buttons. It is never written to disk, and it is dropped the moment a decision lands
or the challenge is abandoned — held, not retained.

Enrolment keeps `{name, embedding, enrolledAt, method}` in `mcp-tools/.state/roster.json` and
discards the source photo. You cannot reconstruct a face from that file, and it is safe to open
on stage — "here is our biometric database", followed by a screen of floats, lands better than
a claim a reviewer has to take on trust.

This is not decoration. GDPR treats facial-recognition templates as **special-category** data
requiring explicit consent and a privacy impact assessment, and the recognised
privacy-protective pattern — the one a phone's own secure enclave uses — is that the template
never leaves the device and the image is not retained. Doing this on-device is what makes the
feature deployable, not merely fast.

`.gitignore` blocks `*.jpg`, `*.png`, `mcp-tools/.state/` and `roster.json`. That block was
added **before** the first capture existed.

## The identity ladder

**`face-cpu` is built and claimed** — verified live 2026-08-06. The Distance Modulino's presence
read (< 1000mm) still opens every challenge and a photo is still captured, but an enrolled person
now resolves automatically; only an unmatched face still needs a human decision. Identity
resolution is architected as a swappable adapter — same idea as the messaging gateway, so a rung
that fails costs a capability rather than the demonstration. Set with `ACCESS_IDENTITY_METHOD`:

| Rung | `ACCESS_IDENTITY_METHOD` | What it does | Status |
|---|---|---|---|
| 1 | `face-npu` | AI Hub-style face model via ONNX Runtime + QNN EP on the Hexagon NPU | not built — no NPU-executing vision script exists yet; the adapter's next rung |
| 2 | `face-cpu` | InsightFace **buffalo_s** — SCRFD-500MF detector + ArcFace MobileFaceNet recognizer, both ONNX, CPU execution via onnxruntime — still entirely on-device | **built, verified live 2026-08-06, claimed** — `mcp-tools/scripts/face_vision.py` (shared pipeline in `face_common.py`) |
| 3 | `stub` *(default)* | detection-only; everyone reads as unknown, loop runs end to end | not claiming a match it never made — remains the safe default for an unconfigured clone |
| 4 | `qr-badge` | a QR code is decoded in-browser by `BarcodeDetector`, and its text is matched against enrolled names | code exists and runs, but not claimed — there's no real badge behind it, just a typed name treated as the credential, and anyone can print a QR code with any name on it |

InsightFace's pretrained models (the buffalo_s bundle behind rung 2) are released for
**non-commercial research purposes only**.

Rungs 1–2 shell out to a Python process (`ACCESS_VISION_SCRIPT`) that reads
`{"imageBase64": "..."}` on stdin and returns `{"embeddings": [[...]], "boxes": [[x,y,w,h]],
"device": "npu"|"cpu"}`. It runs out-of-process deliberately: a native crash in the vision
pipeline must not take the wall down mid-demo. If it fails, the record says so (`degradedFrom`)
rather than hiding it. `ACCESS_VISION_SCRIPT` now ships in this repo — `mcp-tools/scripts/face_vision.py`
— but it runs CPU-only and always reports `device: "cpu"`, which is what makes rung 2 (`face-cpu`)
the one that actually resolves; rung 1 (`face-npu`) still has no NPU-executing script behind it
and stays not built. CPU was the deliberate Phase A choice — deterministic and stable inside a
24-hour ship window; the QNN execution provider is the more failure-prone path, which is exactly
why Phase A didn't reach for it.

The match threshold, `ACCESS_MATCH_THRESHOLD=0.43`, is **provisional** — measured 2026-08-06 on a
3-person roster enrolled from laptop-webcam photos (genuine matches n=23, minimum cosine 0.7702;
impostor pairs n=46, maximum cosine 0.1026; threshold set at the midpoint, rounded down), then
validated live the same day against phone-camera captures — known people scored 0.85 and 0.79.
Small n; re-measure against any larger roster. There is **no liveness detection** — a printed
photo of an enrolled face could pass a match — which is why every non-match still requires a
human decision rather than being treated as final.

The default is still the *least* capable rung that works, so an unconfigured machine understates
what it can do rather than claiming a match it never made. `face-cpu` is opt-in via
`scripts/demo-face-ON.ps1` (back off with `scripts/demo-face-OFF.ps1`, both live-tested
2026-08-06, ~5s, process-scope env only) — `stub` stays the process default. If that changes,
this table is the place to update.

## On-phone inference — benchmarked, then wired in as the failover brain (2026-08-06)

The CLI-over-`adb` path predicted above worked: the `qualcomm/Qwen3-4B-Instruct-2507`
pre-compiled AI Hub Genie bundle (w4a16, ctx 4096) ran on this phone's Hexagon via
`genie-t2t-run` (QAIRT 2.45, hexagon-v79) — **prefill 1,918.0 ± 16.9 tok/s, decode
23.1 ± 1.3 tok/s, TTFT 0.65 s**, warmup + 5 reps, numbers and every config caveat in
[../llm-serving-bench/RESULTS.md](../llm-serving-bench/RESULTS.md#phone-benchmark-snapdragon-8-elite--2026-08-06).
The 12 GB memory risk did not bite at ctx 4096 (~5.4 GB free before load, no OOM); the
phone stayed a working approval terminal throughout. Setup gotcha worth recording:
Samsung's **Auto Blocker** silently blocks USB debugging — it must be off before `adb`
can see the device.

**The same path now serves as the failover brain** (built + verified live the same day):
when a TCP connect to the laptop's GenieX is refused — process dead, not merely busy — a
gateway hook answers the inbound Telegram question on this phone's NPU instead, one-shot,
no tools, delivered to Telegram and the wall labeled *📱 phone-NPU failover — degraded
mode, no tools*. Measured **12.0 s** message→delivered answer, n=1.
It is *compute* failover, not an offline mode — Telegram still needs internet. Design,
limits and the demo arm/disarm scripts: [../hermes-hooks/README.md](../hermes-hooks/README.md).

The **phone leg** of that number is repeatable without killing anything, and was measured at
**7.1 ± 0.7 s over 5 questions** (`llm-serving-bench/phone/failover-reps.ps1`, raw in
`failover-reps/`). The decomposition is the interesting part: **3.83 ± 0.04 s of it is model
load, paid on every single question**, because this path is a one-shot `genie-t2t-run` with
no resident process — 3.2 GB of context binaries reloaded before the first token. Decode is
25.8 tok/s, so answer length sets the rest: ~4.0 s fixed + ~0.04 s per generated token. Full
table and the reason prefill reads 1,100 tok/s here but 1,918 in the bench (prompt length,
not disagreement): [RESULTS.md § failover round-trip](../llm-serving-bench/RESULTS.md#the-failover-round-trip-decomposed--n5-2026-08-07).
Demo dependency through Friday: the bundle stays staged at
`/data/local/tmp/hermes-npu-bench`, USB debugging on, Auto Blocker off.

**Still not implemented:** an on-phone *serving* endpoint (both the bench and the failover
are one-shot CLI runs — no tool-calling, no sustained load tested) and phone-side energy
measurement. See [../docs/HARDWARE_UTILIZATION.md](../docs/HARDWARE_UTILIZATION.md).
