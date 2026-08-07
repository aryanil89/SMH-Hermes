<#
.SYNOPSIS
  Disarm the phone-NPU failover demo beat: re-enable the GenieX supervisor
  and wait until GenieX is actually back (process + listener, never HTTP).

.DESCRIPTION
  Counterpart to demo-failover-ON.ps1. Re-enables and starts the
  SMH-Hermes-GenieX-Supervisor Scheduled Task, then polls the same two
  conditions geniex-supervisor.ps1 itself uses for "alive": a geniex process
  exists AND something is listening on 18181. Deliberately NOT an HTTP check
  -- the repo rule stands: never probe GenieX over HTTP (RUNBOOK, "654 us
  idle vs 1m42s queued").

  Idempotent -- safe to run twice.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\demo-failover-OFF.ps1
#>
[CmdletBinding()]
param()

$SupervisorTask = 'SMH-Hermes-GenieX-Supervisor'
$Port           = 18181

function Say([string]$Level, [string]$Message) {
  $color = switch ($Level) { 'OK' {'Green'} 'WARN' {'Yellow'} 'FAIL' {'Red'} default {'Gray'} }
  Write-Host ("[{0}] {1}" -f $Level, $Message) -ForegroundColor $color
}

# ── 1. Re-enable + start the supervisor task ────────────────────────────────
$task = Get-ScheduledTask -TaskName $SupervisorTask -ErrorAction SilentlyContinue
if (-not $task) {
  Say 'FAIL' "task $SupervisorTask not registered -- run scripts\install-autostart.ps1"
  exit 1
}
Enable-ScheduledTask -TaskName $SupervisorTask | Out-Null
Start-ScheduledTask -TaskName $SupervisorTask
Say 'OK' 'supervisor task enabled and started'

# ── 2. Wait for GenieX: process AND 18181 listener, up to 90s ───────────────
# The supervisor's own loop ticks every 15s and the model load is lazy, so
# the listener can appear well before the first completion is fast.
$deadline = (Get-Date).AddSeconds(90)
$back = $false
while ((Get-Date) -lt $deadline) {
  $proc     = Get-Process geniex -ErrorAction SilentlyContinue
  $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if ($proc -and $listener) { $back = $true; break }
  Start-Sleep -Seconds 3
}

if (-not $back) {
  Say 'FAIL' "GenieX not back within 90s -- check $env:LOCALAPPDATA\hermes\geniex-supervisor.log"
  exit 1
}

Say 'OK'   'FAILOVER DISARMED -- GenieX process up and listening on 18181'
Say 'WARN' 'first completion still pays the lazy model load -- verify with:'
Say 'INFO' '  & "$env:LOCALAPPDATA\hermes\hermes-agent\venv\Scripts\python.exe" hermes-hooks\ack\handler.py --try "is rack B1 hot?"'
exit 0
