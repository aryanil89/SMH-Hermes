<#
.SYNOPSIS
  DEMO-CRITICAL kill-switch: turn the face-recognition backend ON and bring
  the Hermes wall dashboard back up in 'face-cpu' identity mode. ~5s.

.DESCRIPTION
  Counterpart to demo-face-OFF.ps1. Restarts the dashboard with
  ACCESS_IDENTITY_METHOD='face-cpu', pointed at the CPU-only face-vision venv
  and script. Idempotent -- safe to run twice in a row.

  If the python interpreter or the vision script is missing, this still
  proceeds: mcp-tools/src/access/identify.ts drops to face-detect-only when
  the Python child fails to start, which is a safe, by-design degrade -- not
  a reason to refuse restarting the wall.

  Steps: same skeleton as demo-face-OFF.ps1 -- stop whatever owns the
  dashboard port (loopback + 'node' process only; tailscaled's port-7788
  listener is on the tailscale IP and is never touched), set process-scope
  env, relaunch, poll for 200.

.PARAMETER Threshold
  Optional ACCESS_MATCH_THRESHOLD override (cosine similarity, 0-1). Left
  unset if not given, so roster.ts's own default (0.5) applies.

.PARAMETER Secret
  ACCESS_SHARED_SECRET for the dashboard's write routes. If omitted, one is
  generated and persisted to %LOCALAPPDATA%\hermes\access-secret.txt so it
  SURVIVES restarts -- this script is a mid-demo kill-switch, and rotating the
  secret mid-demo would 403 the phone's already-open page. Pass -NoSecret to
  run open (loopback-only rehearsal).

.PARAMETER NoSecret
  Run with the write routes open. Only sane when nothing proxies port 7788
  off loopback.

.PARAMETER NodeExe
  Path to node.exe. Defaults to node on PATH, then the standard install path.

.PARAMETER PythonExe
  Path to the face-vision venv python. Defaults to .venv-face\Scripts\python.exe
  next to the repo checkout (i.e. <repo-parent>\.venv-face).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\demo-face-ON.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\demo-face-ON.ps1 -Threshold 0.6 -NoSecret
#>
[CmdletBinding()]
param(
  [string]$Threshold = '',
  [string]$Secret = '',
  [switch]$NoSecret,
  [string]$NodeExe = '',
  [string]$PythonExe = ''
)

# Everything below is derived from the script's own location -- no machine-
# specific absolute paths. Logs and the face venv sit NEXT TO the checkout, so
# a clone at D:\hack\SMH-Hermes writes D:\hack\hermes-dashboard.log and looks
# for D:\hack\.venv-face.
$RepoRoot     = Split-Path $PSScriptRoot -Parent
$WorkDir      = Split-Path $RepoRoot -Parent
$McpTools     = Join-Path $RepoRoot 'mcp-tools'
$LogOut       = Join-Path $WorkDir 'hermes-dashboard.log'
$LogErr       = Join-Path $WorkDir 'hermes-dashboard.err.log'
$Port         = 7788
$Url          = 'http://127.0.0.1:7788/'
$VisionScript = Join-Path $McpTools 'scripts\face_vision.py'
if ($NodeExe -eq '') {
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  $NodeExe = if ($nodeCmd) { $nodeCmd.Source } else { 'C:\Program Files\nodejs\node.exe' }
}
if ($PythonExe -eq '') { $PythonExe = Join-Path $WorkDir '.venv-face\Scripts\python.exe' }

function Say([string]$Level, [string]$Message) {
  $color = switch ($Level) { 'OK' {'Green'} 'WARN' {'Yellow'} 'FAIL' {'Red'} default {'Gray'} }
  Write-Host ("[{0}] {1}" -f $Level, $Message) -ForegroundColor $color
}

# ── 0. Sanity checks and the shared secret ─────────────────────────────────
# node missing is fatal (there is nothing to launch); missing face files are
# not -- identify.ts degrades to face-detect-only -- but the operator needs to
# know that is what they are about to get.
if (-not (Test-Path $NodeExe)) {
  Say 'FAIL' "node.exe not found ($NodeExe) -- install Node 22+ or pass -NodeExe"
  exit 1
}

# The write routes (approve/deny/enroll) are what the phone reaches over the
# tailnet, so the demo default is LOCKED: generate a secret once and reuse it
# across restarts (a fresh secret per run would 403 the phone's open page).
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

if (-not (Test-Path $PythonExe)) {
  Write-Host "[WARN] python not found at $PythonExe -- dashboard will degrade to detection-only" -ForegroundColor Red
}
if (-not (Test-Path $VisionScript)) {
  Write-Host "[WARN] vision script not found at $VisionScript -- dashboard will degrade to detection-only" -ForegroundColor Red
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
$env:ACCESS_IDENTITY_METHOD   = 'face-cpu'
$env:ACCESS_PYTHON            = $PythonExe
$env:ACCESS_VISION_SCRIPT     = $VisionScript
$env:ACCESS_VISION_TIMEOUT_MS = '20000'
if ($Threshold -ne '') { $env:ACCESS_MATCH_THRESHOLD = $Threshold } else { $env:ACCESS_MATCH_THRESHOLD = $null }
if ($Secret -ne '')    { $env:ACCESS_SHARED_SECRET   = $Secret }    else { $env:ACCESS_SHARED_SECRET   = $null }
$env:DASHBOARD_OPEN_BROWSER   = '0'
# Staleness guard: match the gateway's config.yaml (180s). Without this the wall
# runs on the code default (3600s) and calls an hour-dead board "real" while the
# agent, whose env server gets 180 from config.yaml, says "mock".
$env:UNOQ_LOG_MAX_AGE_S       = '180'

# ── 3. Relaunch ──────────────────────────────────────────────────────────
Say 'RUN' 'starting dashboard (face-cpu identity)'
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
  Say 'OK' 'FACE ON -- dashboard up (face-cpu)'
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
