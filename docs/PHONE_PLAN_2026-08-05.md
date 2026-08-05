# Phone compute plan — from consent surface to third compute plane (2026-08-05)

> **Status: PLANNED, NOT BUILT.** Nothing in this document is implemented. It exists so the
> gap between what the system does today and what is designed next is stated in one place,
> honestly. What *is* built and verified is listed in the README's
> [Today vs. planned](../README.md#today-vs-planned) table.

## Why this plan exists

The Samsung Galaxy S25 Ultra's product role — the authorization plane for physical access
(see [phone/README.md](../phone/README.md)) — is architecturally right: consent belongs on
the device the on-call actually carries. But its silicon is idle. The Snapdragon 8 Elite is
the second-most-capable NPU in this project and today it runs a browser tab, a camera, and
a QR decoder. Separately, two designed behaviours are not yet implemented: the Telegram
notification for an access challenge, and the pager-suppression rule
(`shouldSuppressPage` is written and tested but has no caller).

**Thesis:** the phone stops being a camera-with-a-button and becomes the third compute
plane, with each new workload strengthening an existing story rather than adding a new one:

1. **LLM on the phone's NPU** — a pre-compiled Qwen3 bundle, no app — turning "we have
   three Snapdragons" into "the same model measured on two Hexagon NPUs". Qualcomm's
   published 8 Elite figure (29 tok/s decode) is roughly double the laptop's served Q4_0
   rate, so the phone may *win* this table.
2. **The face-embedding rung of the identity ladder, built for real** on a Hexagon NPU,
   behind the existing `ACCESS_VISION_SCRIPT` seam
   ([identify.ts](../mcp-tools/src/access/identify.ts)) — making "face recognition
   on-device" true instead of aspirational.
3. **Measured energy.** No vendor publishes joules-per-token for either chip; measured
   numbers with honest error bars fill a gap in the Technical Implementation rubric
   (resource utilization, latency, energy efficiency — unbacked claims score zero).

## Research gates — all three verified 2026-08-05

Feasibility was researched before this plan was written; each gate passed. Facts below
marked *verified* were confirmed by fetching the cited page on 2026-08-05.

### Gate A — face embedding on a Hexagon NPU: both paths feasible

**Laptop (primary, easier).** `pip install onnxruntime==1.24.4 onnxruntime-qnn==2.4.0` on
Windows ARM64 gives a QNN execution provider with bundled libs — no SDK install. Models on
Qualcomm AI Hub:

- **CavaFace** (`cavaface`) — 512-d *normalized* face embeddings, 112×112 RGB input, MIT
  license; float ONNX runs as fp16 on the HTP via the default
  `enable_htp_fp16_precision`; AI Hub's own perf table shows ~4.3 ms on X Elite.
  <https://aihub.qualcomm.com/compute/models/cavaface>
- **Lightweight-Face-Detection** (`face_det_lite`) — 480×640 detector, BSD-3;
  postprocessing ships in the `qai_hub_models` pip package.
  <https://aihub.qualcomm.com/models/face_det_lite>
- No ArcFace/FaceNet/MobileFaceNet on AI Hub; `face_attrib_net` is **not** an embedder
  (verified from its model.py — it outputs five attribute probabilities only).

Caveats: the plugin EP has had registration hiccups on X Elite (pin versions exactly, keep
the CPU-EP fallback, which is the same code); `qai-hub-models fetch` drags in torch — if
ARM64 pip fights, download the .onnx from the model pages.
QNN EP docs: <https://onnxruntime.ai/docs/execution-providers/QNN-ExecutionProvider.html>

**Phone (stretch).** AI Hub compile job → QNN context binary for Snapdragon 8 Elite; the
QAIRT Community SDK zip downloads with **no login** (verified via ranged GET):
<https://softwarecenter.qualcomm.com/catalog/item/Qualcomm_AI_Runtime_Community>. Push
`qnn-net-run` + `libQnnHtp*.so` + hexagon-**v79** skels to `/data/local/tmp` (8 Elite HTP
is v79), drive raw float32 tensors over `adb push/pull`. Workflow pattern documented in
<https://docs.pytorch.org/executorch/stable/backends-qualcomm.html>. Unverified: the zip's
internal layout, and exec-from-`/data/local/tmp` on this exact retail unit.

### Gate B — LLM on the phone's NPU: feasible with no app, no account, no build

- **`geniex-bench` standalone Android archive** (~86 MB) — binary + runtime libs including
  HTP files, anonymous S3 download; GenieX's own CI runs it on SM8750 phones from
  `/data/local/tmp` via plain `adb shell`. It prints TTFT/prefill/decode and can print
  generated text (`--prompt-file`), so it doubles as a one-shot generator.
  <https://github.com/qualcomm/GenieX/releases> ·
  bench docs: <https://github.com/qualcomm/GenieX/blob/main/sdk/benchmark/README.md> ·
  S3 URLs: <https://github.com/qualcomm/GenieX/blob/main/notes/bench.md>
- **Pre-compiled Qwen3 bundles for the 8 Elite**, anonymous download (sizes verified by
  HTTP HEAD; tok/s are Qualcomm's published on-device figures):

  | Model | Bundle size | Published decode |
  |---|---|---|
  | Qwen3-4B-Instruct-2507 (w4a16) | 2.53 GB | 27–29 tok/s |
  | Qwen3-1.7B | 1.53 GB | ~54 tok/s |
  | Qwen3-0.6B | 0.65 GB | ~107 tok/s |

  <https://huggingface.co/qualcomm/Qwen3-4B-Instruct-2507>
- **The apples-to-apples row:** geniex-bench's `llama_cpp` plugin runs plain GGUF on the
  NPU — GenieX CI runs `unsloth/Qwen3-4B-Instruct-2507-GGUF:Q4_0` on SM8750, i.e. the
  *identical file* the laptop serves. Same bytes, two Hexagon NPUs, measured.
- Memory: the LLM-on-Genie guidance says 12 GB is in spec for 3B+ models (reduce context
  first if flaky) — the S25 Ultra has exactly 12 GB. Any outcome including an OOM is
  publishable ("4B fits 31.6 GB and not 12 GB — why the laptop keeps the brain").
  <https://github.com/qualcomm/ai-hub-apps/tree/main/tutorials/llm_on_genie>
- GenieX `serve` does **not** exist on Android (verified: CLI/server is Windows/Linux
  only; Android delivery is an app-only AAR + the bench tarball) — so a persistent
  phone-local HTTP endpoint without an app is out of scope.
- Known doc conflict: the llm_on_genie tutorial mentions Hexagon v73 for the 8 Elite, but
  llama.cpp's Snapdragon doc says v79
  (<https://github.com/ggml-org/llama.cpp/blob/master/docs/backend/snapdragon/README.md>).
  Try v79 first; the SDK ships both.

### Gate C — energy measurement: defensible recipes on both devices

- **Phone (±20–30%):** wireless adb (`adb tcpip 5555`, physically unplug USB — USB adb
  charges the phone and corrupts readings), sample
  `/sys/class/power_supply/battery/current_now` + `voltage_now` at ~5 Hz for the run and
  for a 60 s same-state idle baseline; E = mean(|I|·V) × duration, baseline-subtracted.
  Kernel ABI units are µA/µV but Samsung drivers have shipped mA — calibrate the scale
  empirically. `dumpsys thermalservice` before/after each run for throttling honesty.
  `batterystats` is a model estimate — attribution only, never joules.
  Kernel ABI: <https://www.kernel.org/doc/Documentation/ABI/testing/sysfs-class-power>
- **Laptop (±15–25%):** on battery, poll `root\wmi BatteryStatus` → `DischargeRate` (mW)
  at 1 Hz, baseline-subtracted, ≥60 s windows, repeated runs; HWiNFO ARM64 (v8.32+
  exposes Snapdragon per-component power) logging CSV as cross-check; `powercfg
  /batteryreport` as coarse sanity. `srumutil`/E3 is an estimate — attribution only.
- **Citable comparator:** X Elite NPU RAG workload measured at prefill 786.66 tok/s,
  decode 14.19 tok/s, ~2.6 J/query — <https://arxiv.org/html/2606.11257v1> (also
  demonstrates HWiNFO power logging on an X Elite machine).
- **WebNN is a dead end** (verified): Chrome's WebNN origin trial excludes Android — CPU
  inference only, no Hexagon path from the browser
  (<https://groups.google.com/a/chromium.org/g/blink-dev/c/5CWKSChYo98>); Windows ARM64
  WebNN is experimental, NPU not guaranteed. Native GenieX remains the only sound path.

## Phase 0 — Complete the phone's product role (~1 h, laptop-side)

Telegram notification when a challenge opens. In `SnapshotBuilder.recordAccess`
([snapshot.ts](../mcp-tools/src/dashboard/snapshot.ts)), which already detects
verdict/approval transitions via `lastAccessKey`: when a challenge first reaches an
approval-requiring verdict (`challenge`, `anti-passback`, `unauthorized-during-incident`,
`tailgating`), send a Telegram Bot API `sendMessage` — fire-and-forget with `.catch` (a
Telegram failure must never touch the tick loop), one send per challenge id, reusing the
`ACCESS_LABELS` wording table rather than a second copy of the strings. Content: verdict +
zone + link to `http://<tailnet-ip>:7788/phone.html`.

**Text only, no photo — decided.** A face image transiting a third-party relay would
undercut "no biometric leaves the building". The link *is* the notification; the image
stays local. Say this on stage as a deliberate choice.

## Phase 1 — LLM on the phone's NPU (half day; highest value per hour)

1. Download `geniex-bench-android-arm64.tar.gz` and the Qwen3-4B-Instruct-2507
   geniex_qairt w4a16 8 Elite bundle (both anonymous, Gate B). **Unpack and inspect the
   tarball first** — its layout was inferred from CI, not opened.
2. `adb push` both to `/data/local/tmp`; flatten HTP libs per GenieX CI
   (`cp lib/qairt/htp-files/*.so lib/`); run
   `geniex-bench --plugin qairt --device npu -m <bundle> -n 128` with
   `LD_LIBRARY_PATH` / `ADSP_LIBRARY_PATH` / `GENIEX_PLUGIN_PATH` set. Hexagon arch: v79
   first.
3. The apples-to-apples row: the identical Q4_0 GGUF the laptop serves, via the
   `llama_cpp` plugin, `--device npu`. Same prompts as the laptop's existing
   measurements; 3 runs each; record TTFT/prefill/decode.
4. Energy during each run per Gate C recipes, both devices, error bars quoted.
5. Fallback ladder if 4B misbehaves at 12 GB: reduce context → Qwen3-1.7B → Qwen3-0.6B.
   Any outcome is publishable.
6. Results → [HARDWARE_UTILIZATION.md](HARDWARE_UTILIZATION.md): device × runtime ×
   quant × prefill × decode × J/token, with the arXiv comparator cited. Raw output saved
   under `bench/`.
7. *(Stretch, after core lands)* "Failover brain" demo beat: a ~30-line laptop shim that
   execs `adb shell … geniex-bench --prompt-file …` per request. The model reloads per
   call (TTFT tens of seconds), so the beat is pre-warmed at rehearsal: "cut the laptop's
   model — the on-call's phone still answers."

## Phase 2 — Build the face rung on the X Elite NPU (half day)

1. ARM64 Python 3.11–3.13; `pip install onnxruntime==1.24.4 onnxruntime-qnn==2.4.0
   numpy pillow` (Pillow, not opencv — no ARM64 opencv wheel, an established finding).
2. Fetch Face-Det-Lite + CavaFace (Gate A).
3. Write `mcp-tools/vision/embed_faces.py` honoring the **existing contract** in
   [identify.ts](../mcp-tools/src/access/identify.ts): stdin `{"imageBase64"}` → stdout
   `{"embeddings":[[…]], "boxes":[[x,y,w,h]], "device":"npu"|"cpu"}`. Pillow decode →
   detect → crop+margin → 112×112 → embed. Report `device` truthfully from the active
   execution provider. The ladder, matrix, tests and `degradedFrom` fallback all work
   unchanged; enable with `ACCESS_VISION_SCRIPT` + `ACCESS_IDENTITY_METHOD=face`.
4. **Enrolment from a capture:** extend `/api/access/enroll`
   ([server.ts](../mcp-tools/src/dashboard/server.ts)) to accept optional `imageBase64`,
   run the same vision script, store only the resulting embedding — the roster stays
   embeddings-only, the image is discarded; the privacy property is untouched.
   [phone.html](../mcp-tools/public/phone.html)'s enrol card gets a photo option.
5. Calibrate `ACCESS_MATCH_THRESHOLD` against the actually-enrolled team at rehearsal and
   record the measured separation — the 0.5 default is a documented guess and must not
   reach a slide uncalibrated. Consent: enrol only consenting team members; judges opt in
   live.
6. *(Stretch, after core lands)* Phone-side variant: compile CavaFace to a QNN context
   binary for the 8 Elite and run it via `qnn-net-run` over adb (Gate A phone path).
   Story: the biometric template is computed on the same device class that guards your
   fingerprints.

## Phase 3 — Reliability substrate (2–3 h; everything above depends on it)

1. Wrap the four POST handler bodies in
   [server.ts](../mcp-tools/src/dashboard/server.ts) in try/catch → 500, so a failed
   state-file write (file locks are routine on Windows) can no longer kill the process
   via an unhandled rejection.
2. Staleness gate: pass the `stale` bool the snapshot builder already computes into
   `access.update()`; the sentry treats stale presence as "feed lost", not "person
   present" / "person left", and annotates an abandoned challenge with *why* it closed.
3. Wire `shouldSuppressPage` ([decide.ts](../mcp-tools/src/access/decide.ts) — written,
   tested, currently zero call sites) into `check-environmental.js` via the access state
   file, so "known responder on site holds the re-page" becomes behavior rather than a
   wall caption.

## Phase 4 — Docs and demo beats (~2 h)

- [HARDWARE_UTILIZATION.md](HARDWARE_UTILIZATION.md): the two-NPU perf + energy table.
- [phone/README.md](../phone/README.md): move on-phone inference from "Still not
  implemented" to measured results; document the vision-rung env vars.
- Run sheet: challenge → phone buzzes → approve; live `adb shell geniex-bench` generation
  on stage (~30 s); after Phase 3, the "watch it *not* page me" suppression beat. Only
  after Phase 2 lands does "it runs face recognition on-device" become sayable.

## Explicitly out of scope

Android app builds; browser NPU (WebNN on Android is CPU-only — verified); a persistent
llama.cpp `llama-server` NPU build on the phone (needs an x64 Docker toolchain under
emulation); moving the Hermes agent itself onto the phone.

## Verification

- `npx vitest run` stays green (206/206 baseline) after every phase.
- Phase 0: trip the ToF gate → exactly one Telegram message on the phone within ~2 s.
- Phase 1: numbers reproduced twice before entering any doc; raw geniex-bench output kept
  under `bench/`; thermal status logged before/after each run.
- Phase 2: `echo '{"imageBase64":"<test jpg>"}' | python embed_faces.py` returns 512-d
  vectors with `device:"npu"`; live loop: enrol two team members → known person reads
  `clear`, a stranger reads `challenge`; the CPU-EP fallback produces embeddings matching
  the NPU output (cosine > 0.99).
- Phase 3: kill the sensor feed mid-challenge → the wall says "feed lost" and the audit
  record says feed-lost, not "presence ended"; lock the access state file → approve
  returns 500 and the server survives.
