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

  A Scheduled Task action has no environment block, so every setting the wall
  and watchdog need is written INTO the command line here. That is not a detail:
  anything left out is simply absent at boot, with no warning and no failure --
  the component comes up missing a feature and looks healthy. A registration
  that predated this carried nothing, so a reboot produced a wall with face
  recognition off, approve/deny unauthenticated on the tailnet, and the
  staleness guard back on its 3600s code default. The wall task now carries
  UNOQ_LOG_MAX_AGE_S, the ACCESS_* face-identity settings (when the venv and
  vision script are both present -- otherwise it says so and runs
  detection-only), and ACCESS_SHARED_SECRET; the watchdog carries
  UNOQ_LOG_MAX_AGE_S. Keep this in step with scripts\demo-face-ON.ps1, which
  brings up the same dashboard by hand.

  Re-running this script REPLACES the registrations but cannot replace a running
  process: Stop-ScheduledTask kills the powershell wrapper and orphans the node
  grandchild, which keeps the port and the old environment. Anything still
  serving is reported by pid; -Force kills it and starts the new one.

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
  Proceed even if the gateway reports active agents (an in-flight turn), and
  kill a stale wall/watchdog still holding its port so the new registration
  actually takes effect. Without it those are reported and left running.

.PARAMETER NoSecret
  Register the wall with its write routes OPEN (no ACCESS_SHARED_SECRET).
  Loopback-only rehearsal rigs may want this. A machine whose dashboard is
  reachable over the tailnet must not: approve/deny/enroll are the routes that
  grant physical access.

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
  [switch] $Force,
  # Register the wall task with the write routes OPEN. Loopback-only rehearsal
  # rigs may want this; a machine whose dashboard is reachable over the tailnet
  # must not, which is why locked is the default and this is an explicit opt-out.
  [switch] $NoSecret
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

# Face identity + write-route lock, resolved exactly the way demo-face-ON.ps1
# resolves them so the autostart task and the manual kill-switch bring up the
# SAME dashboard. They diverged once and it cost a live demo beat: the task
# action carried no env block at all, so a reboot produced a wall with face
# recognition off, approve/deny unauthenticated on the tailnet, and the
# staleness guard back on its 3600s code default -- none of it announced.
$WorkDir        = Split-Path $RepoRoot -Parent
$VisionScript   = Join-Path $McpTools 'scripts\face_vision.py'
$FacePython     = Join-Path $WorkDir '.venv-face\Scripts\python.exe'
$SecretFile     = Join-Path $HermesHome 'access-secret.txt'

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
# (the default for someone who just cloned the repo), fire-and-forget, bounded
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
  # Everything the dashboard needs rides inside the payload, because the task
  # launches bare node with no env block of its own. Anything omitted here is
  # silently absent at boot -- there is no warning, the wall just comes up with
  # the feature missing, which is how a reboot once produced an unauthenticated,
  # face-blind wall that nobody noticed until someone tried to use it.

  # Same secret file demo-face-ON.ps1 uses, and reused rather than rotated: a
  # fresh key here would 401 the phone's already-open page.
  $wallSecret = ''
  if ($NoSecret) {
    Say 'WARN' 'wall write routes OPEN (-NoSecret) -- approve/deny/enroll unauthenticated'
  } elseif (Test-Path $SecretFile) {
    $wallSecret = (Get-Content $SecretFile -Raw).Trim()
    Say 'OK'   "reusing shared secret -> $SecretFile"
  } elseif ($DryRun) {
    # A dry run must not mint a real key: writing one here would silently become
    # the key every later run reuses, so -DryRun would have configured the rig.
    $wallSecret = '<generated-on-first-real-run>'
    Say 'DRY'  "would generate a shared secret -> $SecretFile"
  } else {
    $rngBytes = New-Object byte[] 18
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($rngBytes)
    $wallSecret = [Convert]::ToBase64String($rngBytes) -replace '[+/=]', ''
    New-Item -ItemType Directory -Force (Split-Path $SecretFile -Parent) | Out-Null
    Set-Content -Path $SecretFile -Value $wallSecret -Encoding ascii
    Say 'OK'   "generated shared secret -> $SecretFile"
  }

  # Face identity only when BOTH halves exist. Pointing the dashboard at a
  # missing interpreter spawns a failing process per capture and arrives at the
  # same detection-only outcome by a noisier route.
  $faceOk = (Test-Path $FacePython) -and (Test-Path $VisionScript)
  if (-not $faceOk) {
    Say 'WARN' 'face identity OFF -- wall will run detection-only (everyone reads as unknown)'
    if (-not (Test-Path $FacePython))   { Say 'WARN' "  missing: $FacePython" }
    if (-not (Test-Path $VisionScript)) { Say 'WARN' "  missing: $VisionScript" }
  }

  # UNOQ_LOG_MAX_AGE_S: without it the wall runs on the code default (3600s) and
  # calls an hour-dead board "real" while the agent, whose env server gets 180
  # from config.yaml, says "mock" -- a live on-stage contradiction.
  $envParts = @("`$env:UNOQ_LOG_MAX_AGE_S='180'")
  if ($faceOk) {
    $envParts += "`$env:ACCESS_IDENTITY_METHOD='face-cpu'"
    $envParts += "`$env:ACCESS_PYTHON='$FacePython'"
    $envParts += "`$env:ACCESS_VISION_SCRIPT='$VisionScript'"
    $envParts += "`$env:ACCESS_VISION_TIMEOUT_MS='20000'"
  }
  # Lands in the task XML, which is readable by this user -- the same user who
  # can already read the secret file in plaintext, so no ground is given up.
  if ($wallSecret -ne '') { $envParts += "`$env:ACCESS_SHARED_SECRET='$wallSecret'" }

  $inner = '"{0}; & ''{1}'' ''{2}'' *>> ''{3}''"' -f ($envParts -join '; '), $node, $WallEntry, $WallLog

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
  #
  # Loopback only. tailscale serve publishes this port on the tailnet addresses,
  # so an unfiltered lookup finds tailscaled's listeners whether or not the wall
  # is up -- and this branch would then decline to start the task FOREVER on any
  # machine where the phone can reach the wall at all, which is every machine
  # that matters. demo-face-ON.ps1 filters correctly; this did not.
  $wallListeners = @(Get-NetTCPConnection -LocalPort 7788 -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalAddress -eq '127.0.0.1' })

  if ($wallListeners.Count -eq 0) {
    Invoke-Step "start '$WallTask' now" { Start-ScheduledTask -TaskName $WallTask }
  } else {
    # A registration that is not running is not in effect, and the process
    # holding the port was started from the PREVIOUS registration -- so it has
    # the old env, which is the whole reason to re-run this script. Saying only
    # "not started" reads as success and leaves the stale wall serving.
    $stale = @($wallListeners | ForEach-Object { Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue } |
      Where-Object { $_ -and $_.ProcessName -eq 'node' })
    if ($stale.Count -eq 0) {
      Say 'WARN' 'loopback 7788 held by a non-node process -- task registered but not started'
    } elseif ($Force) {
      foreach ($p in $stale) {
        $pid_ = $p.Id
        Invoke-Step "stop stale dashboard pid $pid_ (started from the previous registration)" {
          Stop-Process -Id $pid_ -Force -ErrorAction SilentlyContinue
        }
      }
      if (-not $DryRun) { Start-Sleep -Seconds 1 }
      Invoke-Step "start '$WallTask' now" { Start-ScheduledTask -TaskName $WallTask }
    } else {
      Say 'WARN' "task registered but NOT started -- pid $($stale[0].Id) still serving 7788 with the OLD environment"
      Say 'WARN' '  it will keep serving until killed; Stop-ScheduledTask does not reach it'
      Say 'WARN' '  (it kills the powershell wrapper and orphans this node grandchild)'
      Say 'WARN' "  re-run with -Force, or: Stop-Process -Id $($stale[0].Id) -Force; Start-ScheduledTask -TaskName '$WallTask'"
    }
  }

  if ($wallSecret -ne '') {
    Say 'INFO' "wall:  http://127.0.0.1:7788/?secret=$wallSecret"
    Say 'INFO' "phone: append ?secret=$wallSecret to the tailnet phone.html URL"
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
  #
  # Ask the MACHINE and USER scopes, not $env:. The task action carries no env
  # block, so what it gets at logon is the persisted environment -- and $env: is
  # the installing shell, which is a different question with two ways to be
  # wrong. A shell that never inherited them warns about a watchdog that will
  # page perfectly well; worse, a shell where someone typed `$env:TELEGRAM_...`
  # by hand reports all-clear for a task that will be MUTE at every logon. The
  # second is the one that costs an unanswered page at 3am.
  # No ?? here: this script runs under Windows PowerShell 5.1, which has no
  # null-coalescing operator.
  $tgToken = [Environment]::GetEnvironmentVariable('TELEGRAM_BOT_TOKEN','Machine')
  if (-not $tgToken) { $tgToken = [Environment]::GetEnvironmentVariable('TELEGRAM_BOT_TOKEN','User') }
  $tgChat  = [Environment]::GetEnvironmentVariable('TELEGRAM_CHAT_ID','Machine')
  if (-not $tgChat)  { $tgChat  = [Environment]::GetEnvironmentVariable('TELEGRAM_CHAT_ID','User') }
  if (-not $tgToken -or -not $tgChat) {
    Say 'WARN' 'TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are not set at MACHINE or USER scope.'
    Say 'WARN' 'The loop will tick and persist state but CANNOT page the phone.'
    Say 'WARN' 'A value set only in this shell does NOT count -- the task inherits the persisted'
    Say 'WARN' 'environment at logon. Set them with [Environment]::SetEnvironmentVariable(..,''User'').'
  } else {
    Say 'OK'   'TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID found at USER/MACHINE scope -- task will inherit them'
  }

  # Same quoting constraint as the wall display's $inner above, and the same
  # staleness-guard reasoning: the watchdog must judge freshness on the same
  # 180s the gateway's env server uses, or the two disagree about "real".
  $innerWatch = '"$env:UNOQ_LOG_MAX_AGE_S=''180''; & ''{0}'' ''{1}'' *>> ''{2}''"' -f $node, $WatchEntry, $WatchLog

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
  # Same loopback filter and same stale-process handling as the wall above --
  # a watchdog running on the previous registration's env is exactly the failure
  # this script exists to prevent, and it is the one nobody would look for.
  $watchListeners = @(Get-NetTCPConnection -LocalPort $WatchPort -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalAddress -eq '127.0.0.1' })

  if ($watchListeners.Count -eq 0) {
    Invoke-Step "start '$WatchTask' now" { Start-ScheduledTask -TaskName $WatchTask }
  } else {
    $staleWatch = @($watchListeners | ForEach-Object { Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue } |
      Where-Object { $_ -and $_.ProcessName -eq 'node' })
    if ($staleWatch.Count -eq 0) {
      Say 'WARN' "loopback $WatchPort held by a non-node process -- task registered but not started"
    } elseif ($Force) {
      foreach ($p in $staleWatch) {
        $pid_ = $p.Id
        Invoke-Step "stop stale watchdog pid $pid_ (started from the previous registration)" {
          Stop-Process -Id $pid_ -Force -ErrorAction SilentlyContinue
        }
      }
      if (-not $DryRun) { Start-Sleep -Seconds 1 }
      Invoke-Step "start '$WatchTask' now" { Start-ScheduledTask -TaskName $WatchTask }
    } else {
      Say 'WARN' "task registered but NOT started -- pid $($staleWatch[0].Id) still on $WatchPort with the OLD environment"
      Say 'WARN' "  re-run with -Force, or: Stop-Process -Id $($staleWatch[0].Id) -Force; Start-ScheduledTask -TaskName '$WatchTask'"
    }
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
# Loopback only, for the same reason as the start checks above -- and here it
# matters more. `tailscale serve` publishes 7788 on the tailnet addresses, so an
# unfiltered lookup reports "wall display: up" (with tailscaled's pid) even when
# the wall is dead. A false green in the final verification is worse than no
# verification: it is the line an operator reads before walking away.
foreach ($p in @(@{Port=18181; What='geniex'}, @{Port=7788; What='wall display'}, @{Port=$WatchPort; What='watchdog loop'})) {
  $l = @(Get-NetTCPConnection -LocalPort $p.Port -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalAddress -eq '127.0.0.1' })
  if ($l) {
    Say 'OK' "$($p.What) listening on $($p.Port) (pid $($l[0].OwningProcess))"
    $componentStatus += "$($p.What): up"
  } else {
    Say 'WARN' "nothing listening on 127.0.0.1:$($p.Port) yet"
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
