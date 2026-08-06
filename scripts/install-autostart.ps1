<#
.SYNOPSIS
  Make the Hermes gateway and the GenieX supervisor survive reboots and crashes.

.DESCRIPTION
  Before this, every process the demo depends on was a hand-launched window:

    geniex (18181)        <- restarted by geniex-supervisor.ps1
    geniex-supervisor.ps1 <- restarted by NOBODY
    hermes gateway        <- restarted by NOBODY
    wall display (7788)   <- restarted by NOBODY

  So the geniex safety net had a single point of failure, and a reboot or a
  stray window close took the whole demo down with no recovery.

  This registers four Windows Scheduled Tasks:

    Hermes_Gateway                  -- via Hermes' own `gateway install`
    SMH-Hermes-GenieX-Supervisor    -- registered here
    SMH-Hermes-WallDisplay          -- registered here
    SMH-Hermes-Watchdog             -- registered here

  All run at logon with restart-on-failure (1 min interval, 999 attempts) and
  no execution time limit.

  THE WATCHDOG TASK REPLACES THE `hermes cron` ENVIRONMENTAL WATCH. Hermes cron
  cannot fire faster than ~2 minutes on this rig, so sensor-edge-to-Telegram was
  measured at 14-102s with ~86% of it spent waiting for the next tick. The loop
  ticks every 15s. Running both at once pages the on-call twice for every event,
  so section 4 refuses to install while the cron job is still enabled.

  MCP servers need no task: the gateway spawns them over stdio. The Arduino
  UNO Q is a separate device with its own systemd units -- nothing here
  touches it.

  WHY THE GATEWAY IS NOT JUST A schtasks ENTRY WE WRITE: Hermes ships a Windows
  service backend (hermes_cli/gateway_windows.py) that already handles the parts
  that are easy to get wrong -- notably launching through wscript.exe, because a
  console-hosted gateway receives STATUS_CONTROL_C_EXIT at logon, which Task
  Scheduler reads as a *user cancel* so RestartOnFailure never fires. Use theirs.

  SAFETY: a foreground gateway must not run alongside the service one. Hermes
  refuses the combination because it "leaves an orphan dispatcher that escapes
  the service, survives restarts, and writes to the same kanban DB concurrently
  -- which can corrupt it" (hermes_cli/gateway.py). This script stops the
  foreground gateway first, and refuses to do so while an agent turn is in
  flight unless -Force is given.

.PARAMETER Only
  Limit the run to one component: gateway, supervisor, wall, or watch. Default
  'all'. Use this to add a component without bouncing an already-installed
  gateway -- only the gateway section restarts anything.

.PARAMETER DryRun
  Print what would happen and change nothing.

.PARAMETER Force
  Proceed even if the gateway reports active agents (an in-flight turn).

.EXAMPLE
  # Preview:
  powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -DryRun

.EXAMPLE
  # Do it. Run in a REAL terminal -- `gateway install` may raise a UAC prompt.
  powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1

.EXAMPLE
  # Add only the wall display; leaves the running gateway untouched.
  powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Only wall

.NOTES
  Undo:
    hermes gateway uninstall
    Unregister-ScheduledTask -TaskName 'SMH-Hermes-GenieX-Supervisor' -Confirm:$false
    Unregister-ScheduledTask -TaskName 'SMH-Hermes-WallDisplay' -Confirm:$false
    Unregister-ScheduledTask -TaskName 'SMH-Hermes-Watchdog' -Confirm:$false
    # ...and if you want the old cron watchdog back:
    #   hermes cron create --schedule 'every 1m' --name 'Environmental watch' `
    #     --script environmental-watch.py --no-agent --deliver telegram
#>
[CmdletBinding()]
param(
  [ValidateSet('all', 'gateway', 'supervisor', 'wall', 'watch')]
  [string] $Only = 'all',
  [switch] $DryRun,
  [switch] $Force
)

$ErrorActionPreference = 'Stop'

$HermesHome    = "$env:LOCALAPPDATA\hermes"
$HermesExe     = "$HermesHome\hermes-agent\venv\Scripts\hermes.exe"
$SupervisorPs1 = Join-Path $PSScriptRoot 'geniex-supervisor.ps1'
$SupervisorTask = 'SMH-Hermes-GenieX-Supervisor'

$RepoRoot       = Split-Path $PSScriptRoot -Parent
$McpTools       = Join-Path $RepoRoot 'mcp-tools'
$WallEntry      = Join-Path $McpTools 'dist\dashboard\server.js'
$WallTask       = 'SMH-Hermes-WallDisplay'
$WallLog        = "$HermesHome\wall-display.log"
$WatchEntry     = Join-Path $McpTools 'dist\alert-skill\watch-loop.js'
$WatchTask      = 'SMH-Hermes-Watchdog'
$WatchLog       = "$HermesHome\watch-loop.log"
$WatchPort      = 7789
$PsExe          = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"

function Say([string]$Level, [string]$Message) {
  $color = switch ($Level) { 'OK' {'Green'} 'WARN' {'Yellow'} 'FAIL' {'Red'} default {'Gray'} }
  Write-Host ("[{0}] {1}" -f $Level, $Message) -ForegroundColor $color
}

function Invoke-Step([string]$Description, [scriptblock]$Action) {
  if ($DryRun) { Say 'DRY' "would: $Description"; return }
  Say 'RUN' $Description
  & $Action
}

# Same contract as mcp-tools/src/common/telegram.ts: silent no-op when unset
# (the default for a judge who just cloned the repo), fire-and-forget, bounded
# by a timeout, and any failure is logged and swallowed rather than thrown --
# a dead network at startup must not fail an otherwise-successful install.
function Send-TelegramNotice([string]$Text) {
  $token = $env:TELEGRAM_BOT_TOKEN
  $chatId = $env:TELEGRAM_CHAT_ID
  if (-not $token -or -not $chatId) {
    Say 'INFO' 'TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set -- no startup notification sent'
    return
  }
  if ($DryRun) { Say 'DRY' "would notify telegram: $Text"; return }
  try {
    $body = @{ chat_id = $chatId; text = $Text } | ConvertTo-Json
    Invoke-RestMethod -Method Post -Uri "https://api.telegram.org/bot$token/sendMessage" `
      -ContentType 'application/json' -Body $body -TimeoutSec 5 | Out-Null
    Say 'OK' 'telegram notified'
  } catch {
    Say 'WARN' "telegram notify failed (ignored): $($_.Exception.Message)"
  }
}

# ── Preconditions ────────────────────────────────────────────────────────────

if (-not (Test-Path $HermesExe))     { throw "hermes.exe not found at $HermesExe" }
if (-not (Test-Path $SupervisorPs1)) { throw "geniex-supervisor.ps1 not found at $SupervisorPs1" }

Say 'INFO' "hermes     : $HermesExe"
Say 'INFO' "supervisor : $SupervisorPs1"

# Refuse to pull the gateway out from under a running turn. On this box a single
# agent iteration can take 60-300s (full prefill, no KV cache), so "active" is a
# normal steady state rather than a blip -- worth an explicit check.
#
# active_agents is the only trustworthy signal here, so gate on it alone.
# Do NOT try to corroborate it by checking whether geniex is burning CPU: geniex
# sits at 0% while the turn runs a terminal or MCP tool call, so "idle geniex"
# reads as "no turn" and the guard would wave through exactly the interruption it
# exists to prevent. Observed on 2026-08-05 -- active_agents=1 with geniex at
# 0.00s/6s, which cleared on its own a minute later. Age is printed instead so a
# genuinely stuck counter is visible and the operator can decide.
$doGateway    = $Only -in @('all', 'gateway')
$doSupervisor = $Only -in @('all', 'supervisor')
$doWall       = $Only -in @('all', 'wall')
$doWatch      = $Only -in @('all', 'watch')
Say 'INFO' "scope      : $Only"

# Only the gateway section interrupts turns, so only gate on it.
$statePath = "$HermesHome\gateway_state.json"
if ($doGateway -and (Test-Path $statePath)) {
  try {
    $state = Get-Content $statePath -Raw | ConvertFrom-Json
    Say 'INFO' ("gateway pid={0} state={1} active_agents={2}" -f $state.pid, $state.gateway_state, $state.active_agents)
    if ($state.active_agents -gt 0 -and -not $DryRun) {
      $age = [int]((Get-Date) - (Get-Item $statePath).LastWriteTime).TotalSeconds
      if (-not $Force) {
        Say 'FAIL' "gateway reports $($state.active_agents) active agent(s) -- a turn is in flight (last boundary ${age}s ago)."
        Say 'FAIL' 'A turn can legitimately run several minutes: full prefill per model call, no KV cache,'
        Say 'FAIL' 'plus tool calls in between. Wait and re-run, or use -Force to interrupt it.'
        exit 1
      }
      Say 'WARN' "-Force given: interrupting an in-flight turn (last boundary ${age}s ago)."
    }
  } catch { Say 'WARN' "could not parse gateway_state.json: $($_.Exception.Message)" }
}

# ── 1. Gateway -> Scheduled Task (Hermes' own installer) ─────────────────────

if ($doGateway) {
Say 'INFO' '--- gateway ---'

# Stop the foreground gateway BEFORE installing the service (see SAFETY above).
Invoke-Step 'hermes gateway stop' { & $HermesExe gateway stop }

# Both flags must be explicit: _prompt_install_choices only skips its interactive
# questions when start_now AND start_on_login are non-None. Without them this
# blocks forever in a non-interactive shell.
Invoke-Step 'hermes gateway install --start-now --start-on-login' {
  & $HermesExe gateway install --start-now --start-on-login
}
} else { Say 'INFO' "gateway: skipped (-Only $Only)" }

# ── 2. Supervisor -> Scheduled Task ──────────────────────────────────────────

if ($doSupervisor) {
Say 'INFO' '--- geniex supervisor ---'

# The running manual supervisor holds the named mutex, so a task-started instance
# would exit immediately with FATAL and look broken. Close it by PID -- never by
# image name, which would take down unrelated PowerShell windows.
# The -ne $PID guard is the RUNBOOK §2 lesson: a CommandLine match can select the
# very shell running the query, because the pattern appears in its own command.
$manual = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine -like '*geniex-supervisor.ps1*' })
foreach ($m in $manual) {
  Invoke-Step "stop manual supervisor PID $($m.ProcessId) (frees the mutex)" {
    Stop-Process -Id $m.ProcessId -Force -ErrorAction SilentlyContinue
  }
}
if (-not $manual) { Say 'INFO' 'no manual supervisor window found' }

# Settings mirror what Hermes gives its own gateway task, so both recover the
# same way: retry every minute, effectively forever, and never time out.
Invoke-Step "register scheduled task '$SupervisorTask'" {
  $action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
    -Argument ('-ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $SupervisorPs1)
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew `
    -RestartInterval (New-TimeSpan -Minutes 1) -RestartCount 999 `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -StartWhenAvailable
  Register-ScheduledTask -TaskName $SupervisorTask -Action $action -Trigger $trigger `
    -Settings $settings -RunLevel Limited -Force | Out-Null
}

Invoke-Step "start '$SupervisorTask' now" { Start-ScheduledTask -TaskName $SupervisorTask }
} else { Say 'INFO' "supervisor: skipped (-Only $Only)" }

# ── 3. Wall display (127.0.0.1:7788) → Scheduled Task ────────────────────────

# Not decoration. The dashboard is the only writer of .state\access.json, and the
# access sentry FAILS OPEN: with the file stale it pages instead of staying quiet
# (docs\DASHBOARD.md). A dead wall display therefore produces false pages during
# the sentry beat, which is worse than no demo feature at all.

if (-not $doWall) { Say 'INFO' "wall display: skipped (-Only $Only)" }
else {
Say 'INFO' '--- wall display ---'

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node)                  { Say 'WARN' 'node.exe not on PATH -- skipping wall display' }
elseif (-not (Test-Path $WallEntry)) {
  Say 'WARN' "not built: $WallEntry"
  Say 'WARN' 'run `npm run build` in mcp-tools, then re-run this script'
} else {
  Say 'INFO' "node       : $node"
  Say 'INFO' "entry      : $WallEntry"

  # Task Scheduler cannot redirect output, and the task runs hidden -- so wrap in
  # PowerShell purely to capture a log. Without this the only failure signal is
  # "7788 isn't listening", with no reason attached.
  # Quoting is load-bearing: powershell.exe's command-line tokenizer strips bare
  # double quotes before -Command reassembles the text, so paths with spaces
  # must ride as single quotes inside ONE double-quoted payload.
  $inner = '"& ''{0}'' ''{1}'' *>> ''{2}''"' -f $node, $WallEntry, $WallLog

  Invoke-Step "register scheduled task '$WallTask'" {
    $action = New-ScheduledTaskAction -Execute $PsExe `
      -Argument ('-ExecutionPolicy Bypass -WindowStyle Hidden -Command {0}' -f $inner) `
      -WorkingDirectory $McpTools
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
    $settings = New-ScheduledTaskSettingsSet `
      -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
      -MultipleInstances IgnoreNew `
      -RestartInterval (New-TimeSpan -Minutes 1) -RestartCount 999 `
      -ExecutionTimeLimit ([TimeSpan]::Zero) `
      -StartWhenAvailable
    Register-ScheduledTask -TaskName $WallTask -Action $action -Trigger $trigger `
      -Settings $settings -RunLevel Limited -Force | Out-Null
  }

  # Starting a second listener would just EADDRINUSE-crash and then be retried
  # 999 times by the task, so only start when the port is actually free.
  if (Get-NetTCPConnection -LocalPort 7788 -State Listen -ErrorAction SilentlyContinue) {
    Say 'WARN' 'something already listening on 7788 -- task registered but not started'
  } else {
    Invoke-Step "start '$WallTask' now" { Start-ScheduledTask -TaskName $WallTask }
  }
}
}

# ── 4. Watchdog loop (127.0.0.1:7789) → Scheduled Task ───────────────────────

# This REPLACES the `hermes cron` environmental watch. Hermes cron cannot run it
# faster than ~2 minutes -- `parse_duration` has no seconds unit, the ticker
# polls on a 60s grid, and next_run_at is computed from the job's COMPLETION
# time, so an `every 1m` job misses every other poll (measured: 120s x415 at
# "every 1m", 360s x113 at "every 5m", over 547 executions). Sensor edge to
# Telegram measured 14.2s best / 102.2s worst, ~86% of it waiting for a tick.
#
# RUNNING BOTH DOUBLE-PAGES THE ON-CALL. They persist the same state file and
# each would decide and deliver independently, so this refuses to install while
# the cron job is enabled.

if (-not $doWatch) { Say 'INFO' "watchdog: skipped (-Only $Only)" }
else {
Say 'INFO' '--- watchdog loop ---'

# Refuse while the cron job is live. Detected by reading Hermes' own jobs.json
# rather than shelling out, so a broken hermes.exe cannot make this guard pass.
$cronJobs = "$HermesHome\cron\jobs.json"
$cronConflict = $false
if (Test-Path $cronJobs) {
  try {
    $jobs = (Get-Content $cronJobs -Raw | ConvertFrom-Json).jobs
    foreach ($j in $jobs) {
      if ($j.script -like '*environmental-watch*' -and $j.enabled) {
        $cronConflict = $true
        Say 'FAIL' "hermes cron job '$($j.name)' ($($j.id)) is ENABLED and runs $($j.schedule_display)."
        Say 'FAIL' 'Running it alongside this loop pages the on-call twice for every event.'
        Say 'FAIL' "Disable it first:  & `"$HermesExe`" cron delete $($j.id)"
        Say 'FAIL' 'Then re-run this script.'
      }
    }
  } catch { Say 'WARN' "could not parse cron jobs.json: $($_.Exception.Message)" }
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if ($cronConflict -and -not $Force) {
  Say 'FAIL' 'watchdog loop: NOT installed (cron job still enabled). Use -Force to override.'
} elseif (-not $node) { Say 'WARN' 'node.exe not on PATH -- skipping watchdog loop' }
elseif (-not (Test-Path $WatchEntry)) {
  Say 'WARN' "not built: $WatchEntry"
  Say 'WARN' 'run `npm run build` in mcp-tools, then re-run this script'
} else {
  if ($cronConflict) { Say 'WARN' '-Force given: installing the loop while the cron job is ALSO enabled. Expect duplicate pages.' }
  Say 'INFO' "entry      : $WatchEntry"

  # Delivery needs a bot. Without one the loop still ticks and persists state --
  # the wall keeps working -- but nothing reaches the phone, so say so loudly
  # rather than letting a silent thread read as a quiet night.
  if (-not $env:TELEGRAM_BOT_TOKEN -or -not $env:TELEGRAM_CHAT_ID) {
    Say 'WARN' 'TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are not set in this environment.'
    Say 'WARN' 'The loop will tick and persist state but CANNOT page the phone.'
    Say 'WARN' 'Set them as MACHINE or USER environment variables so the scheduled task inherits them.'
  }

  # Same quoting constraint as the wall display's $inner above.
  $innerWatch = '"& ''{0}'' ''{1}'' *>> ''{2}''"' -f $node, $WatchEntry, $WatchLog

  Invoke-Step "register scheduled task '$WatchTask'" {
    $action = New-ScheduledTaskAction -Execute $PsExe `
      -Argument ('-ExecutionPolicy Bypass -WindowStyle Hidden -Command {0}' -f $innerWatch) `
      -WorkingDirectory $McpTools
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
    $settings = New-ScheduledTaskSettingsSet `
      -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
      -MultipleInstances IgnoreNew `
      -RestartInterval (New-TimeSpan -Minutes 1) -RestartCount 999 `
      -ExecutionTimeLimit ([TimeSpan]::Zero) `
      -StartWhenAvailable
    Register-ScheduledTask -TaskName $WatchTask -Action $action -Trigger $trigger `
      -Settings $settings -RunLevel Limited -Force | Out-Null
  }

  # The loop binds $WatchPort as its own single-instance mutex and exits 1 if it
  # is taken, which the task would then retry 999 times. Only start when free.
  if (Get-NetTCPConnection -LocalPort $WatchPort -State Listen -ErrorAction SilentlyContinue) {
    Say 'WARN' "something already listening on $WatchPort -- task registered but not started"
  } else {
    Invoke-Step "start '$WatchTask' now" { Start-ScheduledTask -TaskName $WatchTask }
  }
}
}

# ── 5. Verify ────────────────────────────────────────────────────────────────

if ($DryRun) { Say 'DRY' 'dry run complete -- nothing changed.'; exit 0 }

Start-Sleep -Seconds 8
Say 'INFO' '--- verification ---'

Get-ScheduledTask -TaskName 'Hermes_Gateway*', $SupervisorTask, $WallTask, $WatchTask -ErrorAction SilentlyContinue |
  Select-Object TaskName, State | Format-Table -AutoSize

& $HermesExe gateway status

$componentStatus = @()
foreach ($p in @(@{Port=18181; What='geniex'}, @{Port=7788; What='wall display'}, @{Port=$WatchPort; What='watchdog loop'})) {
  $l = @(Get-NetTCPConnection -LocalPort $p.Port -State Listen -ErrorAction SilentlyContinue)
  if ($l) {
    Say 'OK' "$($p.What) listening on $($p.Port) (pid $($l[0].OwningProcess))"
    $componentStatus += "$($p.What): up"
  } else {
    Say 'WARN' "nothing listening on $($p.Port) yet"
    $componentStatus += "$($p.What): DOWN"
  }
}
# Reported verbatim from Hermes' own state file rather than mapped to up/down:
# this repo does not own hermes.exe and does not know its full state vocabulary,
# so guessing at a boolean risks a false "DOWN" for a state string that just
# was not anticipated.
try {
  $gwState = Get-Content "$HermesHome\gateway_state.json" -Raw -ErrorAction Stop | ConvertFrom-Json
  $componentStatus += "gateway: $($gwState.gateway_state)"
} catch {
  $componentStatus += "gateway: state unknown (no gateway_state.json)"
}

Send-TelegramNotice ("Hermes stack started on $env:COMPUTERNAME`n" + ($componentStatus -join "`n"))

Say 'INFO' 'supervisor log tail:'
Get-Content "$HermesHome\geniex-supervisor.log" -Tail 5 -ErrorAction SilentlyContinue
Say 'INFO' 'wall display log tail:'
Get-Content $WallLog -Tail 5 -ErrorAction SilentlyContinue

Write-Host ''
Say 'OK'   'Done. Remaining checks that this script cannot do for you:'
Say 'INFO' '  1. Kill the gateway PID, wait ~60s, confirm a NEW pid appears (restart-on-failure).'
Say 'INFO' '  2. Log off and back on -- the only true test of the ONLOGON trigger.'
Say 'INFO' '  3. Send one Telegram message to confirm end-to-end delivery.'
