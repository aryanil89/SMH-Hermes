<#
.SYNOPSIS
  Keeps GenieX alive. Restarts it with the documented flags when it dies.

.DESCRIPTION
  GenieX has been observed exiting silently under load -- no crash dump, no
  Windows event, no log file. It closed an in-flight /v1/chat/completions on the
  client and was simply gone. Until that root cause is known, the demo needs a
  supervisor rather than trust.

  HEALTH CHECK IS DELIBERATELY NOT HTTP. GenieX serializes every request behind a
  global lock, including GET /v1/models -- a 654us call when idle took 1m42s
  while a completion was in flight. An HTTP probe therefore cannot distinguish
  "busy" from "dead", and a probe with a timeout SHORT enough to be useful will
  report false deaths during normal inference. Process-alive + listening-socket
  is the only check that stays correct while the model is thinking.

.PARAMETER IntervalSeconds
  Seconds between checks. Default 15.

.PARAMETER Nctx
  Context window. MUST match `model.context_length` in Hermes config.yaml.

.PARAMETER KeepAlive
  Seconds the model stays resident when idle. GenieX defaults to 300, which
  unloads the model between Telegram messages and makes the next reply pay a
  full reload. 3600 keeps it warm across a demo.

.EXAMPLE
  # Leave running in its own window during the demo:
  powershell -ExecutionPolicy Bypass -File scripts\geniex-supervisor.ps1

.EXAMPLE
  # Check what it has been doing:
  Get-Content $env:LOCALAPPDATA\hermes\geniex-supervisor.log -Tail 20
#>
[CmdletBinding()]
param(
  [int]    $IntervalSeconds = 15,
  [int]    $Nctx            = 65536,
  [ValidateSet('npu', 'gpu', 'cpu', 'hybrid')]
  [string] $Compute         = 'npu',
  [int]    $KeepAlive       = 3600,
  [string] $BindHost        = '127.0.0.1:18181',
  [string] $LogPath         = "$env:LOCALAPPDATA\hermes\geniex-supervisor.log"
)

$ErrorActionPreference = 'Stop'
$exe  = "$env:LOCALAPPDATA\GenieX CLI\geniex.exe"
$port = [int]($BindHost -split ':')[-1]

if (-not (Test-Path $exe)) { throw "GenieX not found at $exe" }
$logDir = Split-Path $LogPath -Parent
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

function Write-Log([string]$Level, [string]$Message) {
  $line = "{0} [{1}] {2}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
  Write-Host $line
  Add-Content -Path $LogPath -Value $line -Encoding utf8
}

# Alive = the socket is listening AND a geniex process owns it.
#
# Checking "some geniex exists" + "something listens" separately is not enough:
# both were true here while the listener belonged to a 23 MB GenieX with no model
# loaded and a second, orphaned 5.7 GB instance held nothing. Tying the two
# together is what makes the check mean "the server I can actually reach".
function Test-GenieXAlive {
  $listening = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
  if ($listening.Count -eq 0) { return $false }
  $ownerPid = $listening[0].OwningProcess
  $owner = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
  return ($null -ne $owner -and $owner.ProcessName -eq 'geniex')
}

# Orphaned instances hold gigabytes and serve nothing. Report them; the restart
# path clears them, but a healthy-looking server should not hide one.
function Get-OrphanGenieX {
  $listening = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
  $ownerPid = if ($listening.Count -gt 0) { $listening[0].OwningProcess } else { -1 }
  return @(Get-Process geniex -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne $ownerPid })
}

function Start-GenieX {
  $argList = @(
    'serve',
    '--host', $BindHost,
    '--nctx', $Nctx,
    '--compute', $Compute,
    '--keepalive', $KeepAlive,
    '--skip-update'
  )
  Write-Log 'START' "geniex $($argList -join ' ')"
  # New window so GIN request logs stay visible -- they are the only diagnostic
  # GenieX emits, and there is no log file to fall back on.
  Start-Process -FilePath $exe -ArgumentList $argList -WindowStyle Normal | Out-Null
}

# Warn loudly if the served context disagrees with what Hermes believes it has.
# Hermes will happily build a prompt up to `context_length`; if GenieX allocated
# less, the overflow lands on the server. This mismatch is the leading suspect
# for the silent exits.
function Test-ConfigAgreement {
  $cfg = "$env:LOCALAPPDATA\hermes\config.yaml"
  if (-not (Test-Path $cfg)) { return }
  $m = Select-String -Path $cfg -Pattern '^\s*context_length:\s*(\d+)' | Select-Object -First 1
  if (-not $m) { return }
  $declared = [int]$m.Matches[0].Groups[1].Value
  if ($declared -ne $Nctx) {
    Write-Log 'WARN' "config.yaml context_length=$declared but serving --nctx $Nctx. Make these equal."
  }
}

# Single instance, enforced by the OS rather than by remembering.
#
# Two supervisors is worse than none: each one's restart path kills EVERY geniex
# process, so they take turns killing each other's server and the model reloads
# forever. This happened -- two were running within six minutes of each other,
# simply because starting it is a one-line command that looks idempotent.
$mutexName = 'SMH-Hermes-GenieX-Supervisor'
$mutex = New-Object System.Threading.Mutex($false, $mutexName)
if (-not $mutex.WaitOne(0)) {
  Write-Log 'FATAL' "another supervisor already holds '$mutexName' -- exiting without touching GenieX"
  exit 1
}

try {

Write-Log 'INFO' "supervisor up (interval ${IntervalSeconds}s, nctx $Nctx, compute $Compute, keepalive ${KeepAlive}s)"
Test-ConfigAgreement

$restarts  = 0
$wasAlive  = $null

while ($true) {
  $alive = Test-GenieXAlive

  if ($alive -and $wasAlive -ne $true) {
    Write-Log 'OK' "GenieX healthy on $BindHost"
    foreach ($o in Get-OrphanGenieX) {
      Write-Log 'WARN' ("orphan geniex pid {0} holding {1} MB and serving nothing -- Stop-Process -Id {0}" -f $o.Id, [math]::Round($o.WorkingSet64 / 1MB, 0))
    }
  }
  elseif (-not $alive) {
    if ($wasAlive -eq $true -or $null -eq $wasAlive) {
      Write-Log 'DOWN' 'GenieX not answering (no process or no listener)'
    }
    # Clear any half-dead process before rebinding the port.
    Get-Process geniex -ErrorAction SilentlyContinue | ForEach-Object {
      Write-Log 'KILL' "stale geniex pid $($_.Id)"
      try { Stop-Process -Id $_.Id -Force -ErrorAction Stop } catch {}
    }
    Start-GenieX
    $restarts++
    Write-Log 'INFO' "restart #$restarts; allowing 45s for model load"
    Start-Sleep -Seconds 45
    $wasAlive = $null
    continue
  }

  $wasAlive = $alive
  Start-Sleep -Seconds $IntervalSeconds
}

}
finally {
  # Release the single-instance lock even on Ctrl-C, so the next run is not
  # locked out by a supervisor that no longer exists.
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}
