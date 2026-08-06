<#
.SYNOPSIS
  Gracefully shut down everything install-autostart.ps1 brought up, in the
  order that avoids a false page on the way down -- then, optionally, pull
  main and bring it all back.

.DESCRIPTION
  Four independent things can be running on this box (see install-autostart.ps1
  for how they got here):

    SMH-Hermes-Watchdog             -- environmental watch loop (7789)
    SMH-Hermes-WallDisplay          -- the dashboard / access sentry (7788)
    SMH-Hermes-GenieX-Supervisor    -- keeps geniex.exe (18181) alive
    Hermes_Gateway                  -- the Telegram-facing agent, via hermes.exe

  ORDER MATTERS. docs/DASHBOARD.md: the access sentry fails OPEN -- once
  .state/access.json goes stale (dashboard not writing it) for longer than
  ACCESS_SUPPRESS_MAX_AGE_S (180s default), the watchdog pages regardless of
  who is standing at the rack. Stopping the watchdog FIRST, before the wall
  that feeds it, means that race never opens. Working outward from there:

    1. Watchdog          -- stop the one thing that pages on stale input first
    2. Wall display       -- nothing left downstream still trusts its output
    3. GenieX supervisor, then geniex.exe itself -- stop the supervisor
       before the model process, or it just relaunches what you killed
    4. Hermes gateway     -- via `hermes gateway stop`, same active-agent
       guard install-autostart.ps1 uses, so a live Telegram turn is not
       yanked out from under itself

  MCP servers (network/storage/compute/environmental/rules) need no separate
  step -- the gateway spawns them over stdio as its own children and they go
  with it. The Arduino UNO Q runs its own systemd units and is untouched here.

  Each stop goes through the owning scheduled task first (the mechanism this
  repo already uses to start these processes) and then verifies the port is
  actually free, force-killing the owning process if a task stop left it
  standing -- Task Scheduler does not guarantee a listener closes its socket
  before the stop call returns.

.PARAMETER Force
  Stop the gateway even if it reports an in-flight turn. Same guard and same
  reasoning as install-autostart.ps1 -- a turn here can legitimately run
  60-300s, so without -Force this refuses rather than dropping it.

.PARAMETER PullAndRestart
  Skip the end-of-run prompt and unconditionally pull main + restart. For
  unattended use; interactively the script asks instead.

.PARAMETER DryRun
  Print what would happen and change nothing.

.EXAMPLE
  # Stop everything, then decide interactively whether to update and restart:
  powershell -ExecutionPolicy Bypass -File scripts\stop-all.ps1

.EXAMPLE
  # Unattended: stop, pull main, rebuild, restart, no prompts.
  powershell -ExecutionPolicy Bypass -File scripts\stop-all.ps1 -PullAndRestart
#>
[CmdletBinding()]
param(
  [switch] $Force,
  [switch] $PullAndRestart,
  [switch] $DryRun
)

$ErrorActionPreference = 'Stop'

$HermesHome     = "$env:LOCALAPPDATA\hermes"
$HermesExe      = "$HermesHome\hermes-agent\venv\Scripts\hermes.exe"
$RepoRoot       = Split-Path $PSScriptRoot -Parent
$McpTools       = Join-Path $RepoRoot 'mcp-tools'
$InstallScript  = Join-Path $PSScriptRoot 'install-autostart.ps1'

$WatchTask      = 'SMH-Hermes-Watchdog'
$WatchPort      = 7789
$WallTask       = 'SMH-Hermes-WallDisplay'
$WallPort       = 7788
$SupervisorTask = 'SMH-Hermes-GenieX-Supervisor'

function Say([string]$Level, [string]$Message) {
  $color = switch ($Level) { 'OK' {'Green'} 'WARN' {'Yellow'} 'FAIL' {'Red'} default {'Gray'} }
  Write-Host ("[{0}] {1}" -f $Level, $Message) -ForegroundColor $color
}

function Invoke-Step([string]$Description, [scriptblock]$Action) {
  if ($DryRun) { Say 'DRY' "would: $Description"; return }
  Say 'RUN' $Description
  & $Action
}

# Same contract as mcp-tools/src/common/telegram.ts and install-autostart.ps1's
# copy: silent no-op when unset, fire-and-forget, bounded by a timeout, any
# failure logged and swallowed -- a dead network must not block a shutdown.
function Send-TelegramNotice([string]$Text) {
  $token = $env:TELEGRAM_BOT_TOKEN
  $chatId = $env:TELEGRAM_CHAT_ID
  if (-not $token -or -not $chatId) {
    Say 'INFO' 'TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set -- no shutdown notification sent'
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

# Stop a scheduled task if it exists and is running, then confirm the port it
# owns is actually free -- force-killing whatever still holds it. Same
# owner-pid pattern geniex-supervisor.ps1 uses to tell "listening" from "dead".
function Stop-TaskAndPort([string]$TaskName, [int]$Port) {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $task) {
    Say 'INFO' "$TaskName -- not registered, nothing to stop"
  } elseif ($task.State -ne 'Running') {
    Say 'INFO' "$TaskName -- not running (state: $($task.State))"
  } else {
    Invoke-Step "stop scheduled task '$TaskName'" { Stop-ScheduledTask -TaskName $TaskName }
  }

  if ($DryRun) { return }
  Start-Sleep -Seconds 2
  $listening = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
  if ($listening.Count -eq 0) {
    Say 'OK' "port $Port is free"
    return
  }
  foreach ($l in $listening) {
    Invoke-Step "force-stop pid $($l.OwningProcess) still holding port $Port" {
      Stop-Process -Id $l.OwningProcess -Force -ErrorAction SilentlyContinue
    }
  }
}

Send-TelegramNotice "Hermes stack on $env:COMPUTERNAME is being shut down (by $env:USERNAME)."

# ── 1. Watchdog ───────────────────────────────────────────────────────────────
Say 'INFO' '--- 1/4 watchdog loop ---'
Stop-TaskAndPort -TaskName $WatchTask -Port $WatchPort

# ── 2. Wall display ───────────────────────────────────────────────────────────
Say 'INFO' '--- 2/4 wall display ---'
Stop-TaskAndPort -TaskName $WallTask -Port $WallPort

# ── 3. GenieX supervisor, then GenieX itself ─────────────────────────────────
Say 'INFO' '--- 3/4 geniex supervisor + geniex ---'

$manual = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine -like '*geniex-supervisor.ps1*' })
foreach ($m in $manual) {
  Invoke-Step "stop manual supervisor pid $($m.ProcessId)" {
    Stop-Process -Id $m.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

$task = Get-ScheduledTask -TaskName $SupervisorTask -ErrorAction SilentlyContinue
if ($task -and $task.State -eq 'Running') {
  Invoke-Step "stop scheduled task '$SupervisorTask'" { Stop-ScheduledTask -TaskName $SupervisorTask }
} elseif (-not $manual) {
  Say 'INFO' "$SupervisorTask -- not running"
}

# The supervisor is stopped first deliberately: killing geniex.exe while it is
# still watching just gets it relaunched within one IntervalSeconds tick.
$geniex = @(Get-Process geniex -ErrorAction SilentlyContinue)
if ($geniex.Count -eq 0) {
  Say 'INFO' 'geniex -- not running'
} else {
  foreach ($g in $geniex) {
    Invoke-Step "stop geniex pid $($g.Id)" { Stop-Process -Id $g.Id -Force -ErrorAction SilentlyContinue }
  }
}

# ── 4. Hermes gateway ─────────────────────────────────────────────────────────
Say 'INFO' '--- 4/4 hermes gateway ---'

$blocked = $false
if (-not (Test-Path $HermesExe)) {
  Say 'WARN' "hermes.exe not found at $HermesExe -- skipping gateway stop"
} else {
  $statePath = "$HermesHome\gateway_state.json"
  if (Test-Path $statePath) {
    try {
      $state = Get-Content $statePath -Raw | ConvertFrom-Json
      Say 'INFO' ("gateway pid={0} state={1} active_agents={2}" -f $state.pid, $state.gateway_state, $state.active_agents)
      # Dry run only ever previews -- it must never abort early, same as
      # install-autostart.ps1's identical guard.
      if ($state.active_agents -gt 0 -and -not $DryRun -and -not $Force) {
        $age = [int]((Get-Date) - (Get-Item $statePath).LastWriteTime).TotalSeconds
        Say 'FAIL' "gateway reports $($state.active_agents) active agent(s) -- a turn is in flight (last boundary ${age}s ago)."
        Say 'FAIL' 'Wait and re-run, or use -Force to interrupt it. Everything else has already stopped.'
        $blocked = $true
      } elseif ($state.active_agents -gt 0 -and -not $DryRun) {
        Say 'WARN' "-Force given: interrupting an in-flight turn."
      }
    } catch { Say 'WARN' "could not parse gateway_state.json: $($_.Exception.Message)" }
  }
  if (-not $blocked) {
    Invoke-Step 'hermes gateway stop' { & $HermesExe gateway stop }
  }
}

if ($DryRun) { Say 'DRY' 'dry run complete -- nothing changed.'; exit 0 }

if ($blocked) {
  Say 'FAIL' 'Partial shutdown: watchdog, wall display and geniex are stopped, but the gateway is still running.'
  exit 1
}

Say 'OK' 'Shutdown complete.'

# ── Optional: pull main and bring it back up ─────────────────────────────────

$doRestart = $PullAndRestart
if (-not $doRestart -and [Environment]::UserInteractive) {
  $answer = Read-Host 'Pull the latest code from main and restart the server? [y/N]'
  $doRestart = $answer -match '^[Yy]'
}

if (-not $doRestart) {
  Say 'INFO' 'Leaving the server stopped. Re-run install-autostart.ps1 when ready to bring it back up.'
  exit 0
}

Say 'INFO' '--- pulling main ---'
Push-Location $RepoRoot
try {
  $dirty = (git status --porcelain)
  if ($dirty) {
    Say 'FAIL' "working tree has uncommitted changes -- not pulling. Resolve, then re-run."
    Say 'FAIL' ($dirty | Select-Object -First 10 | Out-String)
    exit 1
  }
  git checkout main
  if ($LASTEXITCODE -ne 0) { Say 'FAIL' 'git checkout main failed -- not restarting.'; exit 1 }
  git pull --ff-only origin main
  if ($LASTEXITCODE -ne 0) { Say 'FAIL' 'git pull --ff-only failed (diverged history?) -- not restarting.'; exit 1 }
} finally {
  Pop-Location
}

Say 'INFO' '--- rebuilding mcp-tools ---'
Push-Location $McpTools
try {
  npm install
  if ($LASTEXITCODE -ne 0) { Say 'FAIL' 'npm install failed -- not restarting.'; exit 1 }
  npm run build
  if ($LASTEXITCODE -ne 0) { Say 'FAIL' 'npm run build failed -- not restarting with a stale dist.'; exit 1 }
} finally {
  Pop-Location
}

Say 'INFO' '--- restarting ---'
& $InstallScript
