#!/system/bin/sh
# Hermes phone-NPU bench rep runner.
# usage: sh run.sh <rep-id> [arch: v79|v75|v73]
# Prompt goes via file (no shell quoting), KPIs via --profile JSON.
BASE=/data/local/tmp/hermes-npu-bench
ARCH=${2:-v79}
export LD_LIBRARY_PATH=$BASE/qairt/lib
export ADSP_LIBRARY_PATH=$BASE/qairt/hexagon-$ARCH/unsigned
cd $BASE/bundle || exit 1

PARA="The facility monitoring system aggregates sensor readings from distributed nodes, correlates anomalies across thermal, acoustic, and vibration channels, applies threshold logic with hysteresis to suppress transient noise, escalates persistent deviations to the on-call responder, records every decision in an append-only audit log, and reconciles clock drift between edge devices so that cross-node event ordering remains trustworthy during incident reconstruction and postmortem analysis. "
FILLER=""
i=0
while [ $i -lt 15 ]; do FILLER="$FILLER$PARA"; i=$((i+1)); done

PF=$BASE/prompt-rep$1.txt
printf '<|im_start|>system\nYou are a concise technical assistant.<|im_end|>\n<|im_start|>user\n[rep-%s] Read the operations description below, then summarize it in about 150 words focusing on failure handling:\n%s<|im_end|>\n<|im_start|>assistant\n' "$1" "$FILLER" > $PF

echo "=== rep $1 arch $ARCH date $(date '+%Y-%m-%d %H:%M:%S')"
echo "=== temp_before $(dumpsys battery | grep temperature)"
echo "=== memavail_before $(grep MemAvailable /proc/meminfo)"
$BASE/qairt/bin/genie-t2t-run -c genie_config.json --prompt_file $PF --profile $BASE/profile-rep$1.json 2>&1
RC=$?
echo "=== exit_code $RC"
echo "=== temp_after $(dumpsys battery | grep temperature)"
echo "=== memavail_after $(grep MemAvailable /proc/meminfo)"
exit $RC
