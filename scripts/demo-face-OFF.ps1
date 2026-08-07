<#
.SYNOPSIS
  DEMO-CRITICAL kill-switch: turn the face-recognition backend OFF and bring
  the Hermes wall dashboard back up in safe 'stub' identity mode. ~5s.

.DESCRIPTION
  Mid-demo escape hatch. If the face-recognition backend misbehaves on stage,
  this restarts the dashboard (node dist\dashboard\server.js) with
  ACCESS_IDENTITY_METHOD forced to 'stub' and every face-vision env var
  cleared, so nothing shells out to Python. Idempotent -- safe to run twice
  in a row.

  Steps:
    1. Find and stop whatever is listening on 127.0.0.1:7788 (the dashboard).
       tailscaled ALSO listens on port 7788, but on the tailscale interface,
       not loopback -- this only ever touches a loopback listener owned by a
       'node' process, so tailscaled is never at risk.
    2. Set process-scope env vars for THIS shell only (never setx / User /
       Machine scope) so the identity method is explicitly 'stub' -- anyone
       reading the config should see intent, not an unset fallback -- and the
       face-vision vars are cleared so the child process does not see them.
    3. Relaunch the dashboard, stdout/stderr redirected to the usual logs.
    4. Poll / until it answers 200, then report FACE OFF, or print the tail
       of the error log if it never came up.

.PARAMETER Secret
  ACCESS_SHARED_SECRET for the dashboard's write routes. If omitted, the one
  persisted at %LOCALAPPDATA%\hermes\access-secret.txt is reused (or created)
  so the phone's already-open page keeps working across the flip to stub.
  Pass -NoSecret to run open (loopback-only rehearsal).

.PARAMETER NoSecret
  Run with the write routes open. Only sane when nothing proxies port 7788
  off loopback.

.PARAMETER NodeExe
  Path to node.exe. Defaults to node on PATH, then the standard install path.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\demo-face-OFF.ps1
#>
[CmdletBinding()]
param(
  [string]$Secret = '',
  [switch]$NoSecret,
  [string]$NodeExe = ''
)

# Paths derive from the script's own location -- no machine-specific absolute
# paths. Logs sit NEXT TO the checkout (see demo-face-ON.ps1 for the layout).
$RepoRoot = Split-Path $PSScriptRoot -Parent
$WorkDir  = Split-Path $RepoRoot -Parent
$McpTools = Join-Path $RepoRoot 'mcp-tools'
$LogOut   = Join-Path $WorkDir 'hermes-dashboard.log'
$LogErr   = Join-Path $WorkDir 'hermes-dashboard.err.log'
$Port     = 7788
$Url      = 'http://127.0.0.1:7788/'
if ($NodeExe -eq '') {
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  $NodeExe = if ($nodeCmd) { $nodeCmd.Source } else { 'C:\Program Files\nodejs\node.exe' }
}

function Say([string]$Level, [string]$Message) {
  $color = switch ($Level) { 'OK' {'Green'} 'WARN' {'Yellow'} 'FAIL' {'Red'} default {'Gray'} }
  Write-Host ("[{0}] {1}" -f $Level, $Message) -ForegroundColor $color
}

# ── 0. Sanity check and the shared secret ──────────────────────────────────
if (-not (Test-Path $NodeExe)) {
  Say 'FAIL' "node.exe not found ($NodeExe) -- install Node 22+ or pass -NodeExe"
  exit 1
}

# Same locked-by-default posture as demo-face-ON.ps1: this escape hatch must
# not silently DROP the lock on the write routes when it flips identity mode.
$SecretFile = Join-Path $env:LOCALAPPDATA 'hermes\access-secret.txt'
if ($NoSecret) {
  $Secret = ''
  Say 'WARN' 'write routes OPEN (-NoSecret) -- loopback-only rehearsal mode'
} elseif ($Secret -eq '') {
  if (Test-Path $SecretFile) { $Secret = (Get-Content $SecretFile -TotalCount 1).Trim() }
  if (-not $Secret) {
    $rngBytes = New-Object byte[] 18
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($rngBytes)
    $Secret = [Convert]::ToBase64String($rngBytes) -replace '[+/=]', ''
    New-Item -ItemType Directory -Force (Split-Path $SecretFile -Parent) | Out-Null
    Set-Content -Path $SecretFile -Value $Secret -Encoding ascii
    Say 'OK' "generated shared secret -> $SecretFile"
  }
}

# ── 1. Stop whatever currently owns the dashboard port ─────────────────────
# Loopback + 'node' process only. tailscaled's listener on this port lives on
# the tailscale IP, not 127.0.0.1, so it can never be matched -- and even a
# loopback listener owned by something other than 'node' is left alone.
$listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalAddress -eq '127.0.0.1' })
if ($listeners.Count -eq 0) {
  Say 'INFO' "nothing listening on 127.0.0.1:$Port"
} else {
  foreach ($l in $listeners) {
    $proc = Get-Process -Id $l.OwningProcess -ErrorAction SilentlyContinue
    if ($proc -and $proc.ProcessName -eq 'node') {
      Say 'RUN' "stopping node pid $($proc.Id) on port $Port"
      Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    } else {
      $name = if ($proc) { $proc.ProcessName } else { '<unknown>' }
      Say 'WARN' "port $Port owned by pid $($l.OwningProcess) ($name), not node -- leaving it alone"
    }
  }
  Start-Sleep -Seconds 1
}

# ── 2. Process-scope env only ───────────────────────────────────────────────
$env:ACCESS_IDENTITY_METHOD   = 'stub'
$env:ACCESS_PYTHON            = $null
$env:ACCESS_VISION_SCRIPT     = $null
$env:ACCESS_VISION_TIMEOUT_MS = $null
$env:ACCESS_MATCH_THRESHOLD   = $null
if ($Secret -ne '') { $env:ACCESS_SHARED_SECRET = $Secret } else { $env:ACCESS_SHARED_SECRET = $null }
$env:DASHBOARD_OPEN_BROWSER   = '0'
# Staleness guard: match the gateway's config.yaml (180s) -- same reasoning as
# demo-face-ON.ps1: the wall must not call a dead board "real" for an hour.
$env:UNOQ_LOG_MAX_AGE_S       = '180'

# ── 3. Relaunch ──────────────────────────────────────────────────────────
Say 'RUN' 'starting dashboard (stub identity)'
try {
  Start-Process -FilePath $NodeExe -ArgumentList 'dist\dashboard\server.js' `
    -WorkingDirectory $McpTools -WindowStyle Hidden `
    -RedirectStandardOutput $LogOut -RedirectStandardError $LogErr
} catch {
  Say 'FAIL' "could not launch node: $($_.Exception.Message)"
  exit 1
}

# ── 4. Wait for it to answer ────────────────────────────────────────────────
$deadline = (Get-Date).AddSeconds(10)
$up = $false
while ((Get-Date) -lt $deadline) {
  try {
    $resp = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
    if ($resp.StatusCode -eq 200) { $up = $true; break }
  } catch {
    # Not up yet -- keep polling until the deadline.
  }
  Start-Sleep -Milliseconds 500
}

if ($up) {
  Say 'OK' 'FACE OFF -- dashboard up (stub)'
  if ($Secret -ne '') {
    Say 'INFO' "wall:  http://127.0.0.1:$Port/?secret=$Secret"
    Say 'INFO' "phone: append ?secret=$Secret to the tailnet phone.html URL"
  }
  exit 0
} else {
  Say 'FAIL' "dashboard did not come up within 10s -- tail of $LogErr :"
  if (Test-Path $LogErr) {
    Get-Content $LogErr -Tail 20 | ForEach-Object { Write-Host $_ }
  } else {
    Say 'WARN' "$LogErr does not exist"
  }
  exit 1
}
