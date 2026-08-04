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
Write-Host "Pulling $BoardPath -> $LocalPath every ${IntervalSeconds}s (Ctrl+C to stop)"

while ($true) {
    # Pull to a temp file first so the reader never sees a half-written file
    # (mirrors the truncated-line tolerance in file-source.ts, but cheaper).
    $tmp = "$LocalPath.pull-tmp"
    adb pull $BoardPath $tmp 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0 -and (Test-Path $tmp)) {
        Move-Item -Force $tmp $LocalPath
    } else {
        Write-Host "pull_sensor_log: adb pull failed (board unplugged?), retrying next cycle"
        if (Test-Path $tmp) { Remove-Item -Force $tmp }
    }
    Start-Sleep -Seconds $IntervalSeconds
}
