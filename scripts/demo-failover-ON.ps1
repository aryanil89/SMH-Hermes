<#
.SYNOPSIS
  DEMO-CRITICAL arm switch for the phone-NPU failover beat. Disables the
  GenieX supervisor so a killed GenieX STAYS dead, then preflights the phone
  path. Does NOT kill GenieX itself -- that is the on-stage moment.

.DESCRIPTION
  Counterpart to demo-failover-OFF.ps1. The failover hook itself is always
  armed (it only fires when a TCP connect to GenieX's port is refused), so
  "arming the demo" is really about the supervisor: SMH-Hermes-GenieX-
  Supervisor restarts a dead GenieX within ~15s, which would turn the demo
  beat into a race. This script:

    1. preflights the phone (adb device present, failover.sh + bundle staged)
    2. preflights the hook (gateway log shows it loaded)
    3. kills any manually-started geniex-supervisor.ps1 loops
       (same pattern as stop-all.ps1 -- the task is not the only way
       a supervisor can be running)
    4. stops AND DISABLES the supervisor Scheduled Task (Disable is required:
       the task has RestartCount 999 + StartWhenAvailable, so a mere Stop
       comes back on its own)
    5. prints the on-stage kill one-liner

  Face recognition, the wall (7788), and the watchdog (7789) are separate
  processes and are not touched. GenieX keeps running until you kill it.

  Idempotent -- safe to run twice.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\demo-failover-ON.ps1
#>
[CmdletBinding()]
param()

$SupervisorTask = 'SMH-Hermes-GenieX-Supervisor'
$PhoneBase      = '/data/local/tmp/hermes-npu-bench'
$GatewayLog     = "$env:LOCALAPPDATA\hermes\logs\gateway.log"
$AdbDefault     = "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Genymobile.scrcpy_Microsoft.Winget.Source_8wekyb3d8bbwe\scrcpy-win64-v3.3.2\adb.exe"

function Say([string]$Level, [string]$Message) {
  $color = switch ($Level) { 'OK' {'Green'} 'WARN' {'Yellow'} 'FAIL' {'Red'} default {'Gray'} }
  Write-Host ("[{0}] {1}" -f $Level, $Message) -ForegroundColor $color
}

$failed = $false

# ── 1. Phone preflight ──────────────────────────────────────────────────────
$Adb = if ($env:HERMES_FAILOVER_ADB) { $env:HERMES_FAILOVER_ADB }
       elseif (Test-Path $AdbDefault) { $AdbDefault }
       else { 'adb' }
Say 'INFO' "adb: $Adb"

$devices = & $Adb devices 2>&1 | Out-String
if ($devices -match '(?m)^\S+\s+device\s*$') {
  Say 'OK' 'phone connected and authorized'
} elseif ($devices -match 'unauthorized') {
  Say 'FAIL' 'phone UNAUTHORIZED -- accept the USB-debugging prompt on it'
  $failed = $true
} else {
  Say 'FAIL' 'no phone visible to adb -- check cable, USB debugging, and Samsung Auto Blocker (must be OFF)'
  $failed = $true
}

if (-not $failed) {
  $staged = & $Adb shell "ls $PhoneBase/failover.sh $PhoneBase/bundle/genie_config.json $PhoneBase/qairt/bin/genie-t2t-run 2>&1" | Out-String
  if ($staged -match 'No such file') {
    Say 'FAIL' "phone bundle not fully staged under $PhoneBase -- re-push it (llm-serving-bench/RESULTS.md, phone section)"
    $failed = $true
  } else {
    Say 'OK' "failover.sh + bundle + genie-t2t-run staged on the phone"
  }
}

# ── 2. Hook preflight ───────────────────────────────────────────────────────
if ((Test-Path $GatewayLog) -and
    (Select-String -Path $GatewayLog -Pattern "Loaded hook 'failover'" -Quiet)) {
  Say 'OK' "gateway log shows the failover hook loaded"
} else {
  Say 'WARN' "no ""Loaded hook 'failover'"" in $GatewayLog -- if the gateway restarted since install this may be a rotated log; otherwise run scripts\install-hermes-hooks.ps1"
}

# ── 3. Kill manually-started supervisor loops ───────────────────────────────
# Same discovery stop-all.ps1 uses: the task is not the only way a supervisor
# can be running, and any survivor resurrects GenieX mid-demo.
$loops = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine -like '*geniex-supervisor.ps1*' })
if ($loops.Count -eq 0) {
  Say 'INFO' 'no manually-started supervisor loops'
} else {
  foreach ($p in $loops) {
    Say 'RUN' "stopping manual supervisor pid $($p.ProcessId)"
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

# ── 4. Stop + DISABLE the supervisor task ───────────────────────────────────
$task = Get-ScheduledTask -TaskName $SupervisorTask -ErrorAction SilentlyContinue
if (-not $task) {
  Say 'WARN' "task $SupervisorTask not registered -- nothing to disable (fresh clone?)"
} else {
  try { Stop-ScheduledTask -TaskName $SupervisorTask -ErrorAction Stop } catch {}
  Disable-ScheduledTask -TaskName $SupervisorTask | Out-Null
  $state = (Get-ScheduledTask -TaskName $SupervisorTask).State
  if ($state -eq 'Disabled') {
    Say 'OK' "supervisor task stopped and DISABLED"
  } else {
    Say 'FAIL' "supervisor task state is '$state', expected Disabled"
    $failed = $true
  }
}

# ── 5. Status + the on-stage moment ─────────────────────────────────────────
$geniex = Get-Process geniex -ErrorAction SilentlyContinue
if ($geniex) {
  Say 'INFO' "GenieX still running (pid $($geniex.Id -join ', ')) -- this script never kills it"
} else {
  Say 'WARN' 'GenieX is not running right now -- every Telegram question will failover to the phone until demo-failover-OFF.ps1'
}

if ($failed) {
  Say 'FAIL' 'FAILOVER ARM INCOMPLETE -- fix the failures above before the demo'
  exit 1
}

Say 'OK'   'FAILOVER ARMED -- a dead GenieX now stays dead'
Say 'INFO' 'on-stage kill:   Get-Process geniex | Stop-Process -Force'
Say 'INFO' 'verify down:     python hermes-hooks\failover\handler.py --probe   (exit 2 = DOWN)'
Say 'INFO' 'restore after:   powershell -ExecutionPolicy Bypass -File scripts\demo-failover-OFF.ps1'
exit 0
