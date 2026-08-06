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
       Machine scope) so the identity method is explicitly 'stub' -- a judge
       reading the config should see intent, not an unset fallback -- and the
       face-vision vars are cleared so the child process does not see them.
    3. Relaunch the dashboard, stdout/stderr redirected to the usual logs.
    4. Poll / until it answers 200, then report FACE OFF, or print the tail
       of the error log if it never came up.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\demo-face-OFF.ps1
#>
[CmdletBinding()]
param()

$McpTools = Join-Path (Split-Path $PSScriptRoot -Parent) 'mcp-tools'
$NodeExe  = 'C:\Program Files\nodejs\node.exe'
$LogOut   = 'C:\Users\qc_de\Downloads\QUAD\hermes-dashboard.log'
$LogErr   = 'C:\Users\qc_de\Downloads\QUAD\hermes-dashboard.err.log'
$Port     = 7788
$Url      = 'http://127.0.0.1:7788/'

function Say([string]$Level, [string]$Message) {
  $color = switch ($Level) { 'OK' {'Green'} 'WARN' {'Yellow'} 'FAIL' {'Red'} default {'Gray'} }
  Write-Host ("[{0}] {1}" -f $Level, $Message) -ForegroundColor $color
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
$env:ACCESS_SHARED_SECRET     = $null
$env:DASHBOARD_OPEN_BROWSER   = '0'

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
