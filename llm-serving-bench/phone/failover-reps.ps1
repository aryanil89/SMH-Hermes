<#
.SYNOPSIS
  Repeat the failover phone round-trip N times and report mean +/- stdev.

.DESCRIPTION
  The headline failover number in the docs was n=1. One sample cannot separate
  "the phone answers in 12 s" from "the phone answered in 12 s once"; a reviewer
  is entitled to ask which, and the honest answer needs reps.

  Two different measurements live in this file, and conflating them is the easy
  mistake:

    -Mode Phone  (default, SAFE)  the phone leg only, via `handler.py --try`.
                                  Prints, sends nothing, and does NOT touch
                                  GenieX -- the laptop stack keeps serving
                                  through the whole run. This is ~9 s of the
                                  ~12 s end-to-end figure.
    -Mode E2E                     message -> delivered, the full beat. This
                                  REQUIRES GenieX to be dead (demo-failover-ON),
                                  so it is destructive to the running stack and
                                  this script will not do it for you: it prints
                                  the steps and stops. Kept here so both numbers
                                  are defined in one place.

  Profiles: failover.sh writes --profile output to the device and keeps only one
  previous generation, so a rep's profile is overwritten two reps later. This
  driver pulls after every rep, which is the only reason the per-rep prefill and
  decode rates survive the run.

.PARAMETER Reps
  How many round-trips. Default 5.

.PARAMETER Mode
  Phone (default) or E2E.

.PARAMETER OutDir
  Where rep logs and pulled profiles land. Default: .\failover-reps

.EXAMPLE
  pwsh -File llm-serving-bench\phone\failover-reps.ps1
  pwsh -File llm-serving-bench\phone\failover-reps.ps1 -Reps 10
#>
[CmdletBinding()]
param(
  [int]$Reps = 5,
  [ValidateSet('Phone', 'E2E')][string]$Mode = 'Phone',
  [string]$OutDir
)

$ErrorActionPreference = 'Stop'

# Invariant decimals. `-f {0:N1}` follows the host locale, and on a machine set
# to a comma-decimal locale this script printed `reps: 6,7, 7,1, 7,3` -- a list
# whose separators and decimal points are the same character. These numbers get
# pasted into docs; they must not depend on who ran it.
$inv = [System.Globalization.CultureInfo]::InvariantCulture
function N1([double]$v) { $v.ToString('0.0', $inv) }

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$handler = Join-Path $repoRoot 'hermes-hooks\failover\handler.py'
$phoneBase = '/data/local/tmp/hermes-npu-bench'
if (-not $OutDir) { $OutDir = Join-Path $PSScriptRoot 'failover-reps' }

if ($Mode -eq 'E2E') {
  Write-Host 'E2E mode is destructive and is not automated here.' -ForegroundColor Yellow
  Write-Host ''
  Write-Host '  1. scripts\demo-failover-ON.ps1     # disables the supervisor, kills GenieX'
  Write-Host '  2. send a real Telegram question, note send -> delivered wall-clock'
  Write-Host '  3. repeat step 2 for each rep (the phone is cold only on the first)'
  Write-Host '  4. scripts\demo-failover-OFF.ps1    # next completion pays the model reload'
  Write-Host ''
  Write-Host 'The phone leg of that number is what -Mode Phone measures, non-destructively.'
  exit 0
}

# ---- serial ----------------------------------------------------------------
# Same rule as handler.py _pick_serial: one usable device is still pinned,
# because adb counts offline/unauthorized lines when it decides a target is
# ambiguous and refuses outright.
$adb = $env:HERMES_FAILOVER_ADB
if (-not $adb) {
  $adb = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages\Genymobile.scrcpy_Microsoft.Winget.Source_8wekyb3d8bbwe\scrcpy-win64-v3.3.2\adb.exe'
}
if (-not (Test-Path $adb)) { $adb = 'adb' }

$serial = $env:HERMES_FAILOVER_SERIAL
if (-not $serial) {
  $usable = @()
  foreach ($line in (& $adb devices)) {
    $parts = $line -split '\s+'
    if ($parts.Count -ge 2 -and $parts[1] -eq 'device') { $usable += $parts[0] }
  }
  if ($usable.Count -eq 0) { Write-Host '[FAIL] no usable adb device' -ForegroundColor Red; exit 1 }
  if ($usable.Count -gt 1) {
    Write-Host "[FAIL] $($usable.Count) usable devices ($($usable -join ', ')) -- set HERMES_FAILOVER_SERIAL" -ForegroundColor Red
    exit 1
  }
  $serial = $usable[0]
}
Write-Host "[INFO] phone: $serial   reps: $Reps   mode: phone-leg only (GenieX untouched)" -ForegroundColor Gray

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# Distinct questions: an identical prompt N times would measure a cache we have
# specifically documented as absent, and a reviewer would be right to discount
# it. Same shape and comparable length, different content.
$questions = @(
  'Rack B1 is running warm. In one sentence, what should the on-call do first?',
  'Humidity in the east zone is climbing. In one sentence, is that worth a page?',
  'A door was left open near rack B1. In one sentence, what is the risk?',
  'Storage latency doubled in zone east. In one sentence, what is the likely cause?',
  'The cooling unit restarted twice today. In one sentence, what should we check?',
  'Ambient temperature crossed 30C. In one sentence, what is the first action?',
  'A leak sensor cleared after firing. In one sentence, do we still investigate?',
  'Network packet loss is flat but storage is slow. In one sentence, what does that suggest?',
  'The rack door has been open ten minutes. In one sentence, what happens next?',
  'Backup throughput fell 12 percent. In one sentence, what is the most likely reason?'
)

$times = @()
for ($i = 1; $i -le $Reps; $i++) {
  $q = $questions[($i - 1) % $questions.Count]
  Write-Host ("[rep {0}/{1}] {2}" -f $i, $Reps, $q) -ForegroundColor Cyan
  $log = Join-Path $OutDir ("rep{0:d2}.log" -f $i)
  # No `2>&1` on either native call below. Windows PowerShell 5.1 wraps a native
  # command's stderr in ErrorRecords, and with $ErrorActionPreference = 'Stop'
  # that aborts the run on output the tool wrote perfectly happily -- adb pull
  # reports progress on stderr, so the driver would die mid-rep.
  $out = & python $handler --try $q
  # Not Out-File: PowerShell 5.1's `-Encoding utf8` writes a BOM, and this repo
  # has already been bitten by a BOM in a generated artifact once.
  [System.IO.File]::WriteAllLines($log, [string[]]$out, (New-Object System.Text.UTF8Encoding($false)))
  $line = $out | Select-String -Pattern 'answered in ([0-9.]+)s' | Select-Object -First 1
  if ($line) {
    $t = [double]$line.Matches[0].Groups[1].Value
    $times += $t
    Write-Host ("          " + (N1 $t) + "s") -ForegroundColor Green
  } else {
    Write-Host '          FAILED -- see the log' -ForegroundColor Red
    $out | Select-Object -Last 3 | ForEach-Object { Write-Host "          $_" -ForegroundColor DarkGray }
  }
  # Pull before the next rep runs: only one previous generation survives on
  # device, so waiting until the end would lose all but the last two.
  $dest = Join-Path $OutDir ("profile-rep{0:d2}.json" -f $i)
  & $adb -s $serial pull "$phoneBase/failover-profile.json" $dest | Out-Null
  if (-not (Test-Path $dest)) { Write-Host '          (no profile on device for this rep)' -ForegroundColor DarkYellow }
}

# ---- summary ---------------------------------------------------------------
Write-Host ''
if ($times.Count -eq 0) { Write-Host '[FAIL] no successful reps' -ForegroundColor Red; exit 1 }
$mean = ($times | Measure-Object -Average).Average
$sd = 0.0
if ($times.Count -gt 1) {
  $ss = ($times | ForEach-Object { [Math]::Pow($_ - $mean, 2) } | Measure-Object -Sum).Sum
  $sd = [Math]::Sqrt($ss / ($times.Count - 1))   # sample stdev, n-1
}
$fmt = ($times | ForEach-Object { N1 $_ }) -join ', '
Write-Host ("  phone round-trip, n={0}: {1} +/- {2} s   (min {3}, max {4})" -f `
  $times.Count, (N1 $mean), (N1 $sd), `
  (N1 ($times | Measure-Object -Minimum).Minimum), `
  (N1 ($times | Measure-Object -Maximum).Maximum)) -ForegroundColor White
Write-Host "  reps: $fmt" -ForegroundColor Gray
Write-Host "  logs + profiles: $OutDir" -ForegroundColor Gray
if ($times.Count -lt $Reps) {
  Write-Host ("  NOTE: {0} of {1} reps failed and are excluded -- say so wherever this number is quoted." -f ($Reps - $times.Count), $Reps) -ForegroundColor Yellow
}
exit 0
