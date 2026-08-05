# phone

Samsung Galaxy S25 Ultra — Snapdragon 8 Elite (SM8750-AC), 12 GB RAM, Android 15 / One UI 8.

There is no app to build. The phone runs two things, both served from the laptop:

1. **Telegram** — the notification channel. One swappable adapter among six the gateway
   already carries (Slack, Teams, Discord, WhatsApp, Signal); see
   [../docs/POSITIONING.md](../docs/POSITIONING.md) §3.
2. **The access terminal** — `http://<laptop>:7788/phone.html`. Live rack status, the camera
   capture for an access challenge, the Approve / Deny control, and roster enrolment.

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
then badge in as `known`:

```powershell
$env:ACCESS_SHARED_SECRET = "pick-something"
```

Then open `…/phone.html?secret=pick-something` on the phone. The server prints a warning at
startup if you bind to a network without one. It is one lock on one door, not an auth system.

**Worked when:** the page shows a green `live` dot, the rack verdict tracks the wall, and
pressing Approve on a challenge changes the laptop wall within a second.

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
| Kept after matching | a numeric embedding **only** |
| Never written anywhere | the image itself |
| Never leaves the laptop | any of it |

Enrolment keeps `{name, embedding, enrolledAt, method}` in `mcp-tools/.state/roster.json` and
discards the source photo. You cannot reconstruct a face from that file, and it is safe to open
on stage — "here is our biometric database", followed by a screen of floats, lands better than
a claim a judge has to take on trust.

This is not decoration. GDPR treats facial-recognition templates as **special-category** data
requiring explicit consent and a privacy impact assessment, and the recognised
privacy-protective pattern — the one a phone's own secure enclave uses — is that the template
never leaves the device and the image is not retained. Doing this on-device is what makes the
feature deployable, not merely fast.

`.gitignore` blocks `*.jpg`, `*.png`, `mcp-tools/.state/` and `roster.json`. That block was
added **before** the first capture existed.

## The identity ladder

Identification is a swappable adapter. The approval loop, the decision matrix and the audit
trail are identical whichever rung answered, so a rung that fails costs a capability rather
than the demonstration. Set with `ACCESS_IDENTITY_METHOD`:

| Rung | `ACCESS_IDENTITY_METHOD` | What it does | Status |
|---|---|---|---|
| 1 | `face-npu` | AI Hub face model via ONNX Runtime + QNN EP on the Hexagon NPU | needs `ACCESS_VISION_SCRIPT` |
| 2 | `face-cpu` | same model, CPU execution — still entirely on-device | needs `ACCESS_VISION_SCRIPT` |
| 3 | `stub` *(default)* | detection-only; everyone reads as unknown, loop runs end to end | **working** |
| 4 | `qr-badge` | printed QR badge, decoded in-browser by `BarcodeDetector` | **working** |

Rungs 1–2 shell out to a Python process (`ACCESS_VISION_SCRIPT`) that reads
`{"imageBase64": "..."}` on stdin and returns `{"embeddings": [[...]], "boxes": [[x,y,w,h]],
"device": "npu"|"cpu"}`. It runs out-of-process deliberately: the QNN execution provider is the
least stable thing in this stack, and a native crash must not take the wall down mid-demo. If
it fails, the record says so (`degradedFrom`) rather than hiding it.

The default is the *least* capable rung that works, so an unconfigured machine understates what
it can do rather than claiming a match it never made.

## Still not implemented

**On-phone inference** — a second GenieX/Qwen3-4B instance on the 8 Elite for a
phone-vs-laptop NPU benchmark. `qualcomm/ai-hub-apps` publishes pre-compiled Genie bundles for
the 8 Elite row with Qwen3-4B as the worked example, and there is a CLI path over `adb`, so
this needs no Android app. The open risk is memory: the tutorial states 12 GB as the minimum
for 3B+ models and this device has exactly 12 GB. An OOM is a publishable result — *4B fits the
X Elite's 31.6 GB and not a 12 GB phone, which is why the laptop keeps the brain* — not a
failure. See [../docs/HARDWARE_UTILIZATION.md](../docs/HARDWARE_UTILIZATION.md).
