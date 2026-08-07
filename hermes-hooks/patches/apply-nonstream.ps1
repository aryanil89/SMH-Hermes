<#
.SYNOPSIS
  Applies the SMH-Hermes non-streaming patch to the installed hermes-agent.

.DESCRIPTION
  GenieX serve's SSE streaming responses end without a finish_reason /
  tool_call frame, so Hermes misreads every completed turn as a mid-stream
  drop and retries forever. This script patches
      <AgentRoot>\agent\conversation_loop.py
  so the streaming decision honors HERMES_FORCE_NONSTREAM=1 (set that in
  %LOCALAPPDATA%\hermes\.env; see hermes.env.example). The change is a no-op
  while the variable is unset.

  The patched content is identical to hermes-hooks\patches\nonstream.diff.
  A string replacement is used instead of patch.exe / git apply because the
  Windows install checkout is CRLF while the git blob is LF, and because
  patch.exe is not guaranteed to exist on a deployer machine.

  Idempotent: if the marker string HERMES_FORCE_NONSTREAM is already present
  in the target file, the script reports that and exits 0 without touching
  anything. A .bak copy of the pristine file is made before modifying.

  Applies to hermes-agent 0.20.0, commit
  91937a6dc3ffbbe2f3be91a500f0ecf962c4cf53 of
  git@github.com:NousResearch/hermes-agent.git (pristine blob of the target
  file: dd8529800aef8f9ac1fd7c4a2cb5a703695c0c36). On any other version the
  anchor line may have moved; the script then fails loudly and changes
  nothing.

  NOTE: `hermes update` rewrites HERMES_HOME and reverts this patch.
  Re-run this script (and scripts\install-hermes-hooks.ps1) afterwards.
  Restart the gateway after patching for the change to take effect.

.PARAMETER AgentRoot
  Root of the hermes-agent install. Default: %LOCALAPPDATA%\hermes\hermes-agent
  (the native Windows install location; there is no ~/.hermes on Windows).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File hermes-hooks\patches\apply-nonstream.ps1
#>
[CmdletBinding()]
param(
    [string]$AgentRoot = "$env:LOCALAPPDATA\hermes\hermes-agent"
)

$ErrorActionPreference = 'Stop'

# Marker used for idempotence detection: present iff the patch is applied.
$Marker = 'HERMES_FORCE_NONSTREAM'

# Pristine anchor line (16-space indent), unique in the unpatched file.
$Anchor = '                _use_streaming = True'

# Replacement block, byte-identical (modulo line endings, which follow the
# target file's own convention) to the hunk in nonstream.diff.
$ReplacementLines = @(
    "                # Local patch (SMH-Hermes hackathon): GenieX serve's streaming",
    '                # responses end without a finish_reason / tool_call frame, so',
    '                # every completed turn is misread as a mid-stream drop and',
    '                # retried forever. HERMES_FORCE_NONSTREAM=1 forces the',
    '                # non-streaming request path, which GenieX handles correctly.',
    '                _use_streaming = not os.environ.get("HERMES_FORCE_NONSTREAM")'
)

$Target = Join-Path $AgentRoot 'agent\conversation_loop.py'

if (-not (Test-Path -LiteralPath $Target)) {
    Write-Error ("Target file not found: {0}`nPass -AgentRoot pointing at the hermes-agent install root (the directory that contains agent\conversation_loop.py)." -f $Target)
    exit 1
}

# Read as UTF-8; the file ships as UTF-8 without BOM and contains non-ASCII.
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$Content = [System.IO.File]::ReadAllText($Target, $Utf8NoBom)

if ($Content.Contains($Marker)) {
    Write-Output ("Already applied: marker '{0}' found in {1}. Nothing to do." -f $Marker, $Target)
    exit 0
}

$AnchorCount = ([regex]::Matches($Content, [regex]::Escape($Anchor))).Count
if ($AnchorCount -ne 1) {
    Write-Error ("Expected exactly one occurrence of the anchor line '{0}' in {1} but found {2}. The installed hermes-agent version probably differs from the pinned one (0.20.0, commit 91937a6d); refusing to guess. Nothing was modified." -f $Anchor.Trim(), $Target, $AnchorCount)
    exit 1
}

# Preserve the file's own line-ending convention (CRLF on a Windows checkout).
if ($Content.Contains("`r`n")) {
    $Nl = "`r`n"
} else {
    $Nl = "`n"
}
$Replacement = $ReplacementLines -join $Nl

# Backup before modifying. An existing .bak is kept - it already holds the
# pristine content from a previous run.
$Backup = "$Target.bak"
if (Test-Path -LiteralPath $Backup) {
    Write-Output ("Backup already exists, keeping it: {0}" -f $Backup)
} else {
    Copy-Item -LiteralPath $Target -Destination $Backup
    Write-Output ("Backup written: {0}" -f $Backup)
}

$Patched = $Content.Replace($Anchor, $Replacement)

# Write back as UTF-8 without BOM (PowerShell 5.1 Set-Content would write
# ANSI or add a BOM; WriteAllText with an explicit encoding does neither).
[System.IO.File]::WriteAllText($Target, $Patched, $Utf8NoBom)

# Verify.
$Check = [System.IO.File]::ReadAllText($Target, $Utf8NoBom)
if (-not $Check.Contains($Marker)) {
    Write-Error ("Post-write verification failed: marker '{0}' not found in {1} after patching. Restore from {2} and investigate." -f $Marker, $Target, $Backup)
    exit 1
}

Write-Output ("Patch applied to {0}." -f $Target)
Write-Output "Ensure HERMES_FORCE_NONSTREAM=1 is set in %LOCALAPPDATA%\hermes\.env, then restart the gateway."
Write-Output "Reminder: 'hermes update' reverts this patch - re-run this script afterwards."
exit 0
