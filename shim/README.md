# shim

Adapter that exposes an OpenAI-compatible `/v1/chat/completions` endpoint and forwards requests to
QUAD's `quad serve` NPU inference server (`/infer`).

Needed because Hermes Agent's custom-provider config expects an OpenAI-style endpoint, while
`quad serve` speaks a custom base64-encoded-tensor JSON API — see
[../docs/HARDWARE_UTILIZATION.md](../docs/HARDWARE_UTILIZATION.md).

**Not yet implemented.** Day 1 task: once the Phi-3.5-mini NPU bundle is built and `quad serve` is
running against it, inspect its actual request/response schema (tokenization is likely handled
internally by the Genie bundle, but this needs confirming against the live server, not assumed)
and write the translation layer here.
