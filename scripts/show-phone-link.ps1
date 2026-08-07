<#
.SYNOPSIS
  Print the ready-to-open phone access-terminal link, and prove the key still works.

.DESCRIPTION
  The on-call phone reaches the access terminal at <tailnet-host>/phone.html?secret=<key>.
  Losing that URL -- a closed tab, a new phone, a bookmark saved without the query
  string -- left no way back except reconstructing it by hand from two places, and
  the existing scripts only ever said "append ?secret=... to the tailnet phone.html
  URL" without saying what that URL is.

  Worse, there is a silent failure that looks identical to a mistyped link: the
  dashboard mints a NEW secret when it is restarted by a script that generates one,
  so a phone holding yesterday's key gets 401 on every capture while the page itself
  looks fine. That happened during a live run. So this does not just print a link --
  it calls the running dashboard with the key and tells you whether the server
  actually accepts it.

  Deliberately a terminal tool and NOT a dashboard endpoint. The wall is loopback-
  bound, but `tailscale serve` proxies to 127.0.0.1, so every tailnet visitor also
  arrives as 127.0.0.1 -- the server cannot distinguish "the operator's own browser"
  from "anyone on the tailnet", and an endpoint that reveals the secret to loopback
  would reveal it to all of them. The wall is also the thing on the projector.

.PARAMETER Port
  Dashboard port. Default 7788.

.PARAMETER NoClipboard
  Skip copying the phone URL to the clipboard.

.EXAMPLE
  pwsh -File scripts/show-phone-link.ps1
#>
[CmdletBinding()]
param(
  [int]$Port = 7788,
  [switch]$NoClipboard
)

$ErrorActionPreference = 'Stop'

function Say([string]$Level, [string]$Message) {
  $color = switch ($Level) {
    'OK'   { 'Green' }
    'WARN' { 'Yellow' }
    'FAIL' { 'Red' }
    default { 'Gray' }
  }
  Write-Host ("[{0,-4}] {1}" -f $Level, $Message) -ForegroundColor $color
}

# ---- the key ---------------------------------------------------------------
# Process env first so an operator running a one-off server with a different
# key sees THAT key, not the file the autostart path uses.
$secret = $env:ACCESS_SHARED_SECRET
$secretFrom = 'ACCESS_SHARED_SECRET (process env)'
if (-not $secret) {
  $secretFile = Join-Path $env:LOCALAPPDATA 'hermes\access-secret.txt'
  if (Test-Path $secretFile) {
    $secret = (Get-Content -Raw -Path $secretFile).Trim()
    $secretFrom = $secretFile
  }
}
if (-not $secret) {
  Say 'FAIL' 'No access key found.'
  Say 'INFO' "Looked at: `$env:ACCESS_SHARED_SECRET and $env:LOCALAPPDATA\hermes\access-secret.txt"
  Say 'INFO' 'Run scripts\demo-face-ON.ps1 (or install-autostart.ps1) to generate one.'
  exit 1
}
Say 'OK' "access key found -- $secretFrom"

# ---- where the phone reaches it -------------------------------------------
$hosts = @()
$tailscale = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
if (Test-Path $tailscale) {
  # `serve status` is the authority on what is actually published, which is not
  # the same question as "is this machine on the tailnet".
  $serve = & $tailscale serve status 2>$null
  foreach ($line in $serve) {
    if ($line -match '^https?://([^/\s]+)') { $hosts += $Matches[1] }
  }
  if (-not $hosts) {
    Say 'WARN' 'Tailscale is installed but nothing is published.'
    Say 'INFO' "Publish the wall with:  & '$tailscale' serve --bg $Port"
  }
} else {
  Say 'WARN' 'Tailscale not found -- the phone can only reach this over the local network.'
}
$hosts = $hosts | Select-Object -Unique

# ---- does the running server accept this key? ------------------------------
# The whole point: a printed link the server rejects is worse than no link,
# because it sends the operator hunting for a typo that is not there.
#
# Probed against a WRITE route, because only those are guarded -- the read paths
# are a display and answer 200 to anyone (docs/DASHBOARD.md § Security). An
# earlier draft of this script probed /api/state and cheerfully certified a
# deliberately-wrong key.
#
# An empty capture body is the safe probe: it cannot enrol, approve or deny
# anything. 401 means the key was rejected, 400 ("imageBase64 or badges is
# required") means it was accepted and the request then failed on its merits.
$verified = $false
$probeBody = '{}'
try {
  Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/access/capture" -Method Post `
    -ContentType 'application/json' -Body $probeBody `
    -Headers @{ 'x-access-secret' = $secret } -TimeoutSec 8 -UseBasicParsing | Out-Null
  # A 2xx here would mean the empty body was accepted, which should not happen;
  # the key is clearly fine either way.
  $verified = $true
  Say 'OK' "the dashboard on 127.0.0.1:$Port accepts this key"
} catch {
  $status = $null
  if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
  if ($status -eq 401) {
    Say 'FAIL' 'the running dashboard REJECTS this key (401).'
    Say 'INFO' 'The server was started with a different key than the one stored here --'
    Say 'INFO' 'this is what makes a phone show "Capture rejected" on a page that looks fine.'
    Say 'INFO' "Fix: re-run scripts\demo-face-ON.ps1 and use the key it prints, or restart the"
    Say 'INFO' '     dashboard with ACCESS_SHARED_SECRET set to the key above.'
  } elseif ($status -eq 400) {
    $verified = $true
    Say 'OK' "the dashboard on 127.0.0.1:$Port accepts this key"
  } elseif ($null -eq $status) {
    Say 'WARN' "nothing is listening on 127.0.0.1:$Port -- the link below is correct, but nothing will answer it yet."
  } else {
    Say 'WARN' "unexpected response from the dashboard (HTTP $status) -- key not verified."
  }
}

# ---- output ----------------------------------------------------------------
$phoneUrls = @()
foreach ($h in $hosts) { $phoneUrls += "http://${h}/phone.html?secret=$secret" }
$localPhone = "http://127.0.0.1:$Port/phone.html?secret=$secret"

Write-Host ''
Write-Host '  PHONE ACCESS TERMINAL' -ForegroundColor Cyan
Write-Host '  ---------------------' -ForegroundColor Cyan
if ($phoneUrls) {
  foreach ($u in $phoneUrls) { Write-Host "  $u" -ForegroundColor White }
} else {
  Write-Host "  $localPhone" -ForegroundColor White
  Write-Host '  (this machine only -- the phone needs a tailnet URL, see the warning above)' -ForegroundColor DarkGray
}
Write-Host ''
Write-Host '  WALL (this laptop)' -ForegroundColor Cyan
Write-Host "  http://127.0.0.1:$Port/?secret=$secret" -ForegroundColor White
Write-Host ''
Say 'WARN' 'These URLs contain the shared access key. Do not put them on the projector.'
Write-Host '       Anyone holding the key can approve or deny rack access.' -ForegroundColor Yellow

if (-not $NoClipboard -and $phoneUrls) {
  try {
    Set-Clipboard -Value $phoneUrls[0]
    Say 'OK' 'phone URL copied to the clipboard'
  } catch {
    Say 'INFO' 'clipboard unavailable -- copy the URL above by hand'
  }
}

if (-not $verified) { exit 2 }
exit 0
