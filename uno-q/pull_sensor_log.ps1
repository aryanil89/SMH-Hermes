# pull_sensor_log.ps1 -- USB/adb fallback for the sensor-log transport.
#
# The primary transport is the board pushing over Tailscale
# (hermes-sensor-logger/push_sensor_log.sh). When the board has no usable
# WiFi/tailnet (e.g. bench work away from the venue network, or a demo table
# where WiFi is not trusted), run this on the laptop instead: it adb-pulls the
# board's local log over the USB cable every 10s and overwrites the same laptop
# file the MCP environmental server reads (UNOQ_SENSOR_LOG). Same file, same
# cadence, no network dependency at all.
#
# Usage:  powershell -File uno-q\pull_sensor_log.ps1
# Stop:   Ctrl+C
param(
    [string]$BoardPath = "/home/arduino/ArduinoApps/hermes-sensor-logger/sensor_log.jsonl",
    [string]$LocalPath = "$PSScriptRoot\..\arduino_uno_q-sensor_log.json",
    [int]$IntervalSeconds = 10
)

$LocalPath = [System.IO.Path]::GetFullPath($LocalPath)

# Single instance, enforced by the OS (same pattern as geniex-supervisor.ps1):
# two pullers share the temp path and race the replace, which surfaces as
# EBUSY in the rules engine ("alert rule engine is degraded").
$mutex = New-Object System.Threading.Mutex($false, 'SMH-Hermes-SensorPuller')
if (-not $mutex.WaitOne(0)) {
    Write-Host "pull_sensor_log: another instance is already running -- exiting"
    exit 1
}

Write-Host "Pulling $BoardPath -> $LocalPath every ${IntervalSeconds}s (Ctrl+C to stop)"

while ($true) {
    # Pull to a per-PID temp file first so the reader never sees a
    # half-written file (mirrors the truncated-line tolerance in
    # file-source.ts, but cheaper).
    $tmp = "$LocalPath.pull-tmp-$PID"
    adb pull $BoardPath $tmp 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0 -and (Test-Path $tmp)) {
        # Move-Item -Force onto an existing file is delete-then-rename -- a
        # reader opening in that window gets EBUSY/ENOENT. File.Replace is
        # the atomic ReplaceFile API; retry briefly if the reader holds the
        # file at that exact moment.
        $replaced = $false
        foreach ($attempt in 1..3) {
            try {
                if (Test-Path $LocalPath) {
                    [System.IO.File]::Replace($tmp, $LocalPath, $null)
                } else {
                    Move-Item -Force $tmp $LocalPath
                }
                $replaced = $true
                break
            } catch {
                Start-Sleep -Milliseconds 200
            }
        }
        if (-not $replaced) {
            Write-Host "pull_sensor_log: replace still locked after 3 tries, keeping previous snapshot this cycle"
            if (Test-Path $tmp) { Remove-Item -Force $tmp -ErrorAction SilentlyContinue }
        }
    } else {
        Write-Host "pull_sensor_log: adb pull failed (board unplugged?), retrying next cycle"
        if (Test-Path $tmp) { Remove-Item -Force $tmp -ErrorAction SilentlyContinue }
    }
    Start-Sleep -Seconds $IntervalSeconds
}
