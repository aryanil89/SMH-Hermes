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

  This registers three Windows Scheduled Tasks:

    Hermes_Gateway                  -- via Hermes' own `gateway install`
    SMH-Hermes-GenieX-Supervisor    -- registered here
    SMH-Hermes-WallDisplay          -- registered here

  All run at logon with restart-on-failure (1 min interval, 999 attempts) and
  no execution time limit.

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
  Limit the run to one component: gateway, supervisor, or wall. Default 'all'.
  Use this to add a component without bouncing an already-installed gateway --
  only the gateway section restarts anything.

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
#>
[CmdletBinding()]
param(
  [ValidateSet('all', 'gateway', 'supervisor', 'wall')]
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
  $inner = '& "{0}" "{1}" *>> "{2}"' -f $node, $WallEntry, $WallLog

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

# ── 4. Verify ────────────────────────────────────────────────────────────────

if ($DryRun) { Say 'DRY' 'dry run complete -- nothing changed.'; exit 0 }

Start-Sleep -Seconds 8
Say 'INFO' '--- verification ---'

Get-ScheduledTask -TaskName 'Hermes_Gateway*', $SupervisorTask, $WallTask -ErrorAction SilentlyContinue |
  Select-Object TaskName, State | Format-Table -AutoSize

& $HermesExe gateway status

foreach ($p in @(@{Port=18181; What='geniex'}, @{Port=7788; What='wall display'})) {
  $l = @(Get-NetTCPConnection -LocalPort $p.Port -State Listen -ErrorAction SilentlyContinue)
  if ($l) { Say 'OK'   "$($p.What) listening on $($p.Port) (pid $($l[0].OwningProcess))" }
  else    { Say 'WARN' "nothing listening on $($p.Port) yet" }
}

Say 'INFO' 'supervisor log tail:'
Get-Content "$HermesHome\geniex-supervisor.log" -Tail 5 -ErrorAction SilentlyContinue
Say 'INFO' 'wall display log tail:'
Get-Content $WallLog -Tail 5 -ErrorAction SilentlyContinue

Write-Host ''
Say 'OK'   'Done. Remaining checks that this script cannot do for you:'
Say 'INFO' '  1. Kill the gateway PID, wait ~60s, confirm a NEW pid appears (restart-on-failure).'
Say 'INFO' '  2. Log off and back on -- the only true test of the ONLOGON trigger.'
Say 'INFO' '  3. Send one Telegram message to confirm end-to-end delivery.'
