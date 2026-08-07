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
$BASE/qairt/bin/genie-t2t-run -c genie_config.json --prompt_file "$PF" 2>&1
RC=$?
echo "=== exit_code $RC"
exit $RC
