<#
.SYNOPSIS
  Start a Cloudflare Tunnel that exposes the local PET server at the
  public URL (e.g. https://software.plusoneco.in).

.EXAMPLE
  .\cloudflare-tunnel.ps1 -Token "<CLOUDFLARE_TUNNEL_TOKEN>"
  .\cloudflared.exe tunnel run --token "<TOKEN>"
#>
param(
  [Parameter(Mandatory = $true)]
  [string]$Token
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path "$PSScriptRoot\..\..").Path

# cloudflared may already be on PATH (installed by the original office-PC
# setup); fall back to a local copy in data/.
$cloudflared = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
if (-not $cloudflared) {
  $local = Join-Path $Root "data\cloudflared.exe"
  if (-not (Test-Path $local)) {
    Write-Host "Downloading cloudflared…"
    $url = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
    Invoke-WebRequest -Uri $url -OutFile $local
  }
  $cloudflared = $local
}

Write-Host "Starting tunnel → public URL fronts http://localhost:8080"
& $cloudflared tunnel run --token $Token
