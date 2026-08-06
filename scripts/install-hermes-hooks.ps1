<#
.SYNOPSIS
  Install this repo's Hermes gateway hooks into HERMES_HOME and restart the gateway.

.DESCRIPTION
  Hermes discovers hooks from %LOCALAPPDATA%\hermes\hooks\<name>\ at gateway
  startup only (gateway/hooks.py -> discover_and_load, called once from
  gateway/run.py). So a hook is installed by copying it there and bouncing the
  gateway; there is no reload path and editing the copy in place does nothing
  until the next restart.

  The source of truth is hermes-hooks/ in this repo, NOT the installed copy.
  HERMES_HOME is outside version control and `hermes update` rewrites parts of
  it -- anything edited only there is one update away from gone. Re-run this
  script after changing a hook here, and after any `hermes update`.

  Installed:

    ack  -- replies to an inbound Telegram message the moment it lands, with a
            one-line receipt written by the local model that names what was
            asked and carries the measured wait estimate. See
            hermes-hooks/README.md for why it blocks the turn it announces.

  SAFETY: restarting the gateway mid-turn loses that turn, and a turn here can
  legitimately run 60-300 s (full prefill per model call, no KV cache). This
  refuses to restart while active_agents > 0 unless -Force is given -- the same
  guard, and the same reasoning, as install-autostart.ps1.

.PARAMETER Only
  Install one hook by directory name instead of all of them.

.PARAMETER NoRestart
  Copy the files and leave the gateway alone. The hook stays dormant until the
  next gateway restart.

.PARAMETER DryRun
  Print what would happen and change nothing.

.PARAMETER Force
  Restart even if the gateway reports an in-flight turn.

.EXAMPLE
  # Preview:
  powershell -ExecutionPolicy Bypass -File scripts\install-hermes-hooks.ps1 -DryRun

.EXAMPLE
  # Install everything and bounce the gateway:
  powershell -ExecutionPolicy Bypass -File scripts\install-hermes-hooks.ps1
#>

[CmdletBinding()]
param(
  [string] $Only = 'all',
  [switch] $NoRestart,
  [switch] $DryRun,
  [switch] $Force
)

$ErrorActionPreference = 'Stop'

$HermesHome = "$env:LOCALAPPDATA\hermes"
$HermesExe  = "$HermesHome\hermes-agent\venv\Scripts\hermes.exe"
# The interpreter that will actually import the handler -- check it with that
# one, not with whatever `python` happens to be on PATH.
$HermesPy   = "$HermesHome\hermes-agent\venv\Scripts\python.exe"
$HooksDir   = Join-Path $HermesHome 'hooks'
$RepoRoot   = Split-Path $PSScriptRoot -Parent
$SourceDir  = Join-Path $RepoRoot 'hermes-hooks'

function Say([string]$Level, [string]$Message) {
  $color = switch ($Level) { 'OK' {'Green'} 'WARN' {'Yellow'} 'FAIL' {'Red'} default {'Gray'} }
  Write-Host ("[{0}] {1}" -f $Level, $Message) -ForegroundColor $color
}

# ── Preconditions ────────────────────────────────────────────────────────────

if (-not (Test-Path $HermesExe))  { throw "hermes.exe not found at $HermesExe" }
if (-not (Test-Path $HermesPy))   { throw "gateway python not found at $HermesPy" }
if (-not (Test-Path $SourceDir))  { throw "hook source not found at $SourceDir" }

Say 'INFO' "source : $SourceDir"
Say 'INFO' "target : $HooksDir"

$hooks = Get-ChildItem -Path $SourceDir -Directory |
  Where-Object { Test-Path (Join-Path $_.FullName 'HOOK.yaml') }
if ($Only -ne 'all') { $hooks = $hooks | Where-Object { $_.Name -eq $Only } }
if (-not $hooks) { throw "no hooks to install (Only='$Only')" }
Say 'INFO' ("hooks  : {0}" -f (($hooks | ForEach-Object Name) -join ', '))

# A hook that throws on import is skipped by Hermes with one line on stdout and
# the gateway carries on -- which reads exactly like a hook that installed fine
# and never fires. Catch it here, where it is still a visible failure.
foreach ($hook in $hooks) {
  $handler = Join-Path $hook.FullName 'handler.py'
  if (-not (Test-Path $handler)) { throw "$($hook.Name): handler.py missing" }
  & $HermesPy -c "import ast,sys; ast.parse(open(sys.argv[1],encoding='utf-8').read())" $handler
  if ($LASTEXITCODE -ne 0) { throw "$($hook.Name): handler.py does not parse under the gateway interpreter" }
  Say 'OK' "$($hook.Name): handler.py parses"

  # Hooks with a --selftest entry point run it here. A hook whose logic is
  # broken still loads, still fires, and still returns silently, so "installed"
  # is not evidence of anything on its own.
  if (Select-String -Path $handler -Pattern '--selftest' -SimpleMatch -Quiet) {
    $selftest = & $HermesPy $handler --selftest 2>&1
    if ($LASTEXITCODE -eq 0) {
      Say 'OK' "$($hook.Name): self-test passed"
    } else {
      $selftest | Select-Object -Last 12 | ForEach-Object { Say 'WARN' "  $_" }
      throw "$($hook.Name): self-test failed -- not installing a hook that fails its own checks"
    }
  } else {
    Say 'WARN' "$($hook.Name): no --selftest entry point; installing unverified"
  }
}

# ── Restart guard ────────────────────────────────────────────────────────────

$statePath = "$HermesHome\gateway_state.json"
if (-not $NoRestart -and (Test-Path $statePath)) {
  try {
    $state = Get-Content $statePath -Raw | ConvertFrom-Json
    Say 'INFO' ("gateway pid={0} state={1} active_agents={2}" -f $state.pid, $state.gateway_state, $state.active_agents)
    if ($state.active_agents -gt 0 -and -not $DryRun -and -not $Force) {
      $age = [int]((Get-Date) - (Get-Item $statePath).LastWriteTime).TotalSeconds
      Say 'FAIL' "gateway reports $($state.active_agents) active agent(s) -- a turn is in flight (last boundary ${age}s ago)."
      Say 'FAIL' 'Restarting now would lose that turn. Wait and re-run, use -Force, or -NoRestart'
      Say 'FAIL' 'to stage the files and pick up the hook on the next restart.'
      exit 1
    }
  } catch { Say 'WARN' "could not parse gateway_state.json: $($_.Exception.Message)" }
}

# ── Copy ─────────────────────────────────────────────────────────────────────

foreach ($hook in $hooks) {
  $dest = Join-Path $HooksDir $hook.Name
  if ($DryRun) { Say 'DRY' "would copy $($hook.FullName) -> $dest"; continue }
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  # Copy the two files Hermes reads rather than mirroring the tree: __pycache__
  # from a self-test run must not follow the source into HERMES_HOME.
  Copy-Item (Join-Path $hook.FullName 'HOOK.yaml')  $dest -Force
  Copy-Item (Join-Path $hook.FullName 'handler.py') $dest -Force
  Say 'OK' "installed $($hook.Name) -> $dest"
}

# ── Restart ──────────────────────────────────────────────────────────────────

if ($NoRestart) {
  Say 'WARN' 'gateway not restarted (-NoRestart): hooks load at startup, so nothing fires yet.'
} elseif ($DryRun) {
  Say 'DRY' 'would: hermes gateway restart'
} else {
  Say 'RUN' 'hermes gateway restart'
  & $HermesExe gateway restart
  & $HermesExe gateway status
}

Say 'INFO' 'Confirm the hook loaded: look for "[hooks] Loaded hook ''ack''" in the gateway log'
Say 'INFO' "  $HermesHome\logs\  (or hermes-gateway.err.log at the repo parent)"
