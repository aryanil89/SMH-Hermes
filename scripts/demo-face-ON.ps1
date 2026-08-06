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
  Optional ACCESS_SHARED_SECRET for the dashboard's write routes. Left unset
  (open) if not given -- fine on loopback, per dashboard/server.ts.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\demo-face-ON.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\demo-face-ON.ps1 -Threshold 0.6
#>
[CmdletBinding()]
param(
  [string]$Threshold = '',
  [string]$Secret = ''
)

$McpTools     = Join-Path (Split-Path $PSScriptRoot -Parent) 'mcp-tools'
$NodeExe      = 'C:\Program Files\nodejs\node.exe'
$LogOut       = 'C:\Users\qc_de\Downloads\QUAD\hermes-dashboard.log'
$LogErr       = 'C:\Users\qc_de\Downloads\QUAD\hermes-dashboard.err.log'
$Port         = 7788
$Url          = 'http://127.0.0.1:7788/'
$PythonExe    = 'C:\Users\qc_de\Downloads\QUAD\.venv-face\Scripts\python.exe'
$VisionScript = 'C:\Users\qc_de\Downloads\QUAD\SMH-Hermes\mcp-tools\scripts\face_vision.py'

function Say([string]$Level, [string]$Message) {
  $color = switch ($Level) { 'OK' {'Green'} 'WARN' {'Yellow'} 'FAIL' {'Red'} default {'Gray'} }
  Write-Host ("[{0}] {1}" -f $Level, $Message) -ForegroundColor $color
}

# ── 0. Sanity-check the face backend before touching anything running ──────
# Missing files are not fatal -- identify.ts degrades to face-detect-only --
# but the operator needs to know that is what they are about to get.
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
