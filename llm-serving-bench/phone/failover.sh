#!/system/bin/sh
# Hermes phone-NPU failover runner. Companion to run.sh (the bench harness);
# takes an already-built ChatML prompt file instead of composing one, and
# keeps stdout CLEAN -- no dumpsys/meminfo echoes (they flooded the bench rep
# logs with battery events) -- because the caller parses [BEGIN]:...[END].
# usage: sh failover.sh [prompt-file] [arch: v79|v75|v73]
BASE=/data/local/tmp/hermes-npu-bench
PF=${1:-$BASE/failover-prompt.txt}
ARCH=${2:-v79}
export LD_LIBRARY_PATH=$BASE/qairt/lib
export ADSP_LIBRARY_PATH=$BASE/qairt/hexagon-$ARCH/unsigned
[ -f "$PF" ] || { echo "[FAILOVER-ERROR] prompt file missing: $PF"; exit 2; }
cd $BASE/bundle || { echo "[FAILOVER-ERROR] bundle missing at $BASE/bundle"; exit 3; }

# One inference at a time.
#
# A leftover genie-t2t-run holds the NPU and the ~344 MB resident model, and the
# next call is the demo's recovery beat -- the one inference that must not fail.
#
# Measured on this rig (USB adb, 2026-08-07), the hook's own timeout does NOT
# strand one: killing the adb client, and killing the adb server, both take the
# phone-side process with them, because adbd tears down the shell's process
# group when the socket closes. This guard is not for that case. It is for the
# ones where nothing tears anything down -- adb over TCP across a network
# partition, a bench run.sh inference someone started by hand, a genie wedged in
# a DSP call that outlived its parent. Cost when the phone is clean: one pgrep.
#
# The pattern is bracketed deliberately. `pgrep -f genie-t2t-run` also matches
# the shell running the pgrep, because that shell's command line contains the
# pattern -- verified on device, the naive form reports a pid with nothing
# running. `genie-t2t-ru[n]` matches a real command line and never our own.
STALE=$(pgrep -f "genie-t2t-ru[n]" 2>/dev/null)
if [ -n "$STALE" ]; then
  echo "[FAILOVER-WARN] clearing abandoned inference: $STALE"
  kill $STALE 2>/dev/null
  sleep 1
  # SIGKILL only whatever ignored SIGTERM: a wedged DSP call can sit in an
  # uninterruptible acquire and never handle the polite signal.
  STILL=$(pgrep -f "genie-t2t-ru[n]" 2>/dev/null)
  if [ -n "$STILL" ]; then
    echo "[FAILOVER-WARN] SIGTERM ignored, killing: $STILL"
    kill -9 $STILL 2>/dev/null
    sleep 1
  fi
fi
# --profile self-documents every live failover call (load/prefill/decode split)
# without touching stdout; pull the evidence with:
#   adb pull /data/local/tmp/hermes-npu-bench/failover-profile.json
#   adb pull /data/local/tmp/hermes-npu-bench/failover-profile.prev.json
# NOTE: the phone runs its staged copy -- re-push this file at venue preflight.
#
# genie-t2t-run REFUSES to start when the profile file already exists -- it
# exits 1 with "Invalid --profile argument ... already exists" before loading
# the model. Verified on device: the first failover succeeds and every one
# after it fails in under a second. Left alone that would break the second
# recovery beat of the demo, which is the one a judge asks for.
#
# So: keep exactly one previous run for comparison, and if the path still
# cannot be cleared, run WITHOUT profiling. The answer is the product; the
# profile is evidence about it, and evidence collection must never be the
# reason the recovery path fails.
PROF=$BASE/failover-profile.json
PROF_ARGS="--profile $PROF"
if [ -e "$PROF" ]; then
  mv -f "$PROF" "$BASE/failover-profile.prev.json" 2>/dev/null || rm -f "$PROF" 2>/dev/null
fi
if [ -e "$PROF" ]; then
  echo "[FAILOVER-WARN] could not clear $PROF -- running without profiling"
  PROF_ARGS=""
fi
$BASE/qairt/bin/genie-t2t-run -c genie_config.json --prompt_file "$PF" $PROF_ARGS 2>&1
RC=$?
echo "=== exit_code $RC"
exit $RC
