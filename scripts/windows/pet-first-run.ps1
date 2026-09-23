<#
.SYNOPSIS
  First-run setup for the PET backend on the office PC.

.DESCRIPTION
  • checks Node.js is installed
  • installs npm dependencies (no VS Build Tools required — the SQLite
    driver falls back from better-sqlite3 to the built-in/wasm driver)
  • writes .env from .env.example when missing
  • bootstraps the Main Admin account

.EXAMPLE
  .\pet-first-run.ps1 -AdminEmail admin@plusoneco.in -BootstrapAdmin
  .\pet-first-run.ps1 -AdminEmail admin@plusoneco.in -AdminPassword "Secret123" -PublicUrl https://app.plusoneco.in
#>
param(
  [string]$AdminEmail = "",
  [string]$AdminPassword = "",
  [string]$PublicUrl = "",
  [switch]$BootstrapAdmin
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot\..\..

Write-Host "── PET backend first run ─────────────────────────"

# 1. Node check (18+ works; 20 LTS recommended for the office PC)
try {
  $nodeVersion = (node -v) -replace "^v", ""
  $major = [int]($nodeVersion -split "\.")[0]
  if ($major -lt 18) { throw "Node $nodeVersion is too old" }
  Write-Host "  node $nodeVersion OK"
} catch {
  Write-Error "Node.js 18+ is required. Install Node 20 LTS from https://nodejs.org and re-run."
  exit 1
}

# 2. Dependencies (install must never fail on missing C++ build tools)
Write-Host "  installing dependencies…"
npm install --no-fund --no-audit
if ($LASTEXITCODE -ne 0) { Write-Error "npm install failed"; exit 1 }

# 3. .env
if (-not (Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
  Write-Host "  created .env from .env.example"
}
if ($PublicUrl) {
  $env_ = Get-Content ".env" -Raw
  $env_ = $env_ -replace "(?m)^CORS_ORIGINS=.*$", "CORS_ORIGINS=$PublicUrl,https://software.plusoneco.in"
  Set-Content ".env" $env_ -NoNewline
  Write-Host "  CORS_ORIGINS → $PublicUrl"
}

# 4. Main Admin
if ($BootstrapAdmin) {
  if (-not $AdminEmail) { Write-Error "-AdminEmail is required with -BootstrapAdmin"; exit 1 }
  if ($AdminPassword) {
    npm run bootstrap-admin -- --email $AdminEmail --password $AdminPassword --reset
  } else {
    npm run bootstrap-admin -- --email $AdminEmail --reset
  }
}

Write-Host ""
Write-Host "Done. Start the server with:  npm start"
Write-Host "Health check:                 http://localhost:8080/health"
