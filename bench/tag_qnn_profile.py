"""Tag a qnn-profile-viewer JSON report so QAIRT Visualizer will classify it.

Why this is needed: QAIRT Visualizer decides which panel to open by regex-matching an
"artifact_type" key in the first chunk of the file. The JSON that
`qnn-profile-viewer --reader libQnnJsonProfilingReader.so` emits carries {metadata, messages}
with no such key, so the Visualizer opens it as "unsupported" -- even though its own
performance parser consumes exactly that {messages: [...]} shape (it categorises
BACKEND_CREATE_FROM_BINARY / BACKEND_EXECUTE / APP_EXECUTE_IPS / BACKEND_DEINIT).

This script adds the single key "artifact_type": "QNN_PROFILE" and changes nothing else.
No measured value is touched, added, or recomputed -- every number in the output is the
reader's own output. Optionally gzips the result (the Visualizer accepts .json.gz).

Usage:
  python tag_qnn_profile.py <in.json> [-o out.json] [--gzip]
"""
import argparse
import gzip
import json
import os
import shutil
import sys

TAG = "QNN_PROFILE"
REQUIRED_METHODS = {"BACKEND_EXECUTE"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("-o", "--output")
    ap.add_argument("--gzip", action="store_true", help="also write <output>.gz")
    args = ap.parse_args()

    with open(args.input, encoding="utf-8") as fh:
        report = json.load(fh)

    if "messages" not in report:
        sys.exit("refusing: input has no 'messages' array -- not a qnn-profile-viewer "
                 "JSON report")
    methods = {m.get("method") for m in report["messages"]}
    missing = REQUIRED_METHODS - methods
    if missing:
        sys.exit(f"refusing: input lacks expected profiling methods {sorted(missing)}")

    if report.get("artifact_type") == TAG:
        print("already tagged")
    tagged = {"artifact_type": TAG}
    tagged.update(report)

    out = args.output or args.input.replace(".json", "") + "-tagged.json"
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(tagged, fh)
    print(f"wrote {out} ({os.path.getsize(out)} bytes); "
          f"{len(report['messages'])} messages, methods={sorted(methods)}")

    if args.gzip:
        with open(out, "rb") as src, gzip.open(out + ".gz", "wb", compresslevel=9) as dst:
            shutil.copyfileobj(src, dst)
        print(f"wrote {out}.gz ({os.path.getsize(out + '.gz')} bytes)")


if __name__ == "__main__":
    sys.exit(main())
