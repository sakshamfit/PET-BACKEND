<#
.SYNOPSIS
  Install / remove the PET backend as a background task on Windows.

.DESCRIPTION
  Registers a Scheduled Task that runs `node src/server.js` at startup and
  keeps it alive — no NSSM, no WinSW, no extra downloads. The office PC
  just needs Node on PATH.

.EXAMPLE
  .\install-server-service.ps1              # install
  .\install-server-service.ps1 -Action Restart
  .\install-server-service.ps1 -Action Remove
#>
param(
  [ValidateSet("Install", "Start", "Stop", "Restart", "Status", "Remove")]
  [string]$Action = "Install"
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path "$PSScriptRoot\..\..").Path
$TaskName = "PET-Backend"
$NodeExe = (Get-Command node).Source

function Install-Task {
  Write-Host "Registering scheduled task '$TaskName'…"
  schtasks /Create /F /TN $TaskName `
    /TR "cmd /c cd /d `"$Root`" && `"$NodeExe`" src\server.js >> `"$Root\data\server.log`" 2>&1" `
    /SC ONSTART /RU SYSTEM /RL HIGHEST | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "schtasks failed ($LASTEXITCODE)" }
  New-Item -ItemType Directory -Force -Path "$Root\data" | Out-Null
  Write-Host "Installed. Start it with:  .\install-server-service.ps1 -Action Start"
}

switch ($Action) {
  "Install" { Install-Task; schtasks /Run /TN $TaskName | Out-Null; Write-Host "Started." }
  "Start"   { schtasks /Run /TN $TaskName | Out-Null; Write-Host "Start requested." }
  "Stop"    { schtasks /End /TN $TaskName | Out-Null; Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $NodeExe } | Stop-Process -Force -ErrorAction SilentlyContinue; Write-Host "Stopped." }
  "Restart" { & $PSCommandPath -Action Stop; Start-Sleep -Seconds 2; & $PSCommandPath -Action Start }
  "Status"  { schtasks /Query /TN $TaskName /FO LIST /V }
  "Remove"  { schtasks /Delete /F /TN $TaskName | Out-Null; Write-Host "Removed task '$TaskName'." }
}
