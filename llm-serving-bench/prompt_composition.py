"""Measure the token composition of a real Hermes request, per block.

Why this exists: with no cross-request KV cache (see cache_probe.py), the whole
prompt is re-prefilled on every model call, so prompt SIZE is the only latency
lever we own. To spend effort in the right place you need to know which block is
actually big -- intuition got this wrong (MCP schemas turn out to be the
*smallest* of the three fixed blocks).

Method: GenieX v0.3.18 exposes no /tokenize (404 on /tokenize, /v1/tokenize,
/detokenize, /props), so each block is sent alone with max_tokens=1 and
usage.prompt_tokens is diffed against a trivial baseline. That measures real
tokens through the production chat template rather than a chars/token estimate.

Read-only with respect to Hermes: opens state.db in ro mode, never writes config.

Usage:
    python prompt_composition.py                # composition of the live prompt
    python prompt_composition.py --prune-delta  # + exact saving of the skills cut

WARNING: this sends real completions to the production server on 18181. Each is
a few thousand prefill tokens (~10-20 s). Run it while the server is idle. Do NOT
start a second geniex to run it against -- a second Hexagon process destabilises
the DSP (RESULTS.md stability finding 2).
"""
import argparse
import json
import os
import re
import sqlite3
import sys
import urllib.request

HERMES = os.environ.get("HERMES_HOME") or os.path.join(
    os.environ.get("LOCALAPPDATA", ""), "hermes"
)
ENDPOINT = "http://127.0.0.1:18181/v1/chat/completions"
MODEL = "unsloth/Qwen3-4B-Instruct-2507-GGUF:Q4_0"
KEEP = "environmental-watch"

# Fixed overhead of a fresh session (history=0), measured when the non-stream
# timeout was diagnosed. Used to derive the built-in tool schema block, which
# cannot be measured directly (Hermes builds that tools array internally).
FRESH_SESSION_ANCHOR = 9825


def probe(label, messages, tools=None):
    payload = {"model": MODEL, "messages": messages, "max_tokens": 1}
    if tools:
        payload["tools"] = tools
    req = urllib.request.Request(
        ENDPOINT,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=900) as r:
        body = json.load(r)
    n = body["usage"]["prompt_tokens"]
    print(f"  {label:38s} prompt_tokens = {n}", flush=True)
    return n


def newest_telegram_system_prompt():
    """Return the system prompt text of the most recent Telegram session."""
    con = sqlite3.connect(f"file:{HERMES}/state.db?mode=ro", uri=True)
    row = con.execute(
        "select p.prompt from sessions s join system_prompts p"
        "  on p.hash = s.system_prompt_hash"
        " where s.source = 'telegram' order by s.started_at desc limit 1"
    ).fetchone()
    con.close()
    if not row:
        sys.exit("no telegram session found in state.db")
    return row[0]


def mcp_tools_array():
    """Rebuild the OpenAI tools array from Hermes' MCP discovery cache.

    Names use the mcp__<server>__<tool> form Hermes puts on the wire (visible in
    state.db message rows), so the token count matches production framing.
    """
    with open(f"{HERMES}/cache/mcp_schema_cache.json", encoding="utf-8") as f:
        cache = json.load(f)
    tools = []
    for server, entry in cache.items():
        for t in entry.get("tools", []):
            tools.append({
                "type": "function",
                "function": {
                    "name": f"mcp__{server}__{t['name']}",
                    "description": t.get("description", ""),
                    "parameters": t.get("inputSchema", {}),
                },
            })
    return tools


def prune_skills(sys_prompt):
    """Render what the catalogue looks like once every skill but KEEP is disabled."""
    a = sys_prompt.find("<available_skills>")
    b = sys_prompt.find("</available_skills>")
    if a < 0 or b < 0:
        return None
    head, body, tail = sys_prompt[:a], sys_prompt[a:b], sys_prompt[b:]
    out, keep_cat = [], False
    for line in body.split("\n"):
        if re.match(r"^  [a-z0-9/_-]+:", line):
            keep_cat = line.strip().startswith(KEEP)
            if keep_cat:
                out.append(line)
        elif line.strip().startswith("- "):
            if keep_cat and KEEP in line:
                out.append(line)
        else:
            out.append(line)
    return head + "\n".join(out) + tail


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prune-delta", action="store_true",
                    help="also measure the exact saving of the skills-catalogue cut")
    args = ap.parse_args()

    sys_prompt = newest_telegram_system_prompt()
    tools = mcp_tools_array()
    user = [{"role": "user", "content": "hi"}]

    print(f"system prompt : {len(sys_prompt)} chars")
    print(f"mcp tools     : {len(tools)} tools, {len(json.dumps(tools))} chars\n")

    print("probing (each line is one real completion):")
    base = probe("A. baseline (user 'hi' only)", user)
    withsys = probe("B. + system prompt", [{"role": "system", "content": sys_prompt}] + user)
    withtools = probe("C. + MCP tools array", user, tools=tools)

    sys_tok, mcp_tok = withsys - base, withtools - base
    residual = FRESH_SESSION_ANCHOR - sys_tok - mcp_tok - base

    print("\ncomposition of the fixed overhead:")
    print(f"  built-in tool schemas (residual) {residual:6d} tok")
    print(f"  system prompt                    {sys_tok:6d} tok")
    print(f"  MCP tool schemas                 {mcp_tok:6d} tok")
    print(f"  chat template                    {base:6d} tok")
    print(f"  ------------------------------------------")
    print(f"  anchor (fresh session, history=0){FRESH_SESSION_ANCHOR:6d} tok")

    result = {
        "chat_template": base,
        "system_prompt": sys_tok,
        "mcp_tools": mcp_tok,
        "builtin_tools_residual": residual,
        "anchor_fresh_session": FRESH_SESSION_ANCHOR,
    }

    if args.prune_delta:
        pruned = prune_skills(sys_prompt)
        if pruned is None:
            print("\n(no <available_skills> block found -- prune already applied?)")
        else:
            print("\nskills-catalogue cut:")
            after = probe("D. system prompt, skills pruned",
                          [{"role": "system", "content": pruned}] + user)
            saved = withsys - after
            print(f"\n  chars removed {len(sys_prompt) - len(pruned)}")
            print(f"  TOKENS SAVED  {saved} per model call")
            print(f"  ~{saved/206:.1f}s @206 tok/s, ~{saved/150:.1f}s @150, "
                  f"~{3*saved/206:.1f}s on a 3-call turn")
            result["skills_prune_tokens_saved"] = saved

    print("\nJSON:", json.dumps(result))


if __name__ == "__main__":
    main()
