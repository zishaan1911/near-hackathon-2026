<#
  Sets the Vercel environment variables the cron tick needs.

  Run from the repo root (G:\near-hackathon-2026) after `vercel link`:
    pwsh ./scripts/setup-vercel-secrets.ps1

  - GASX_NEAR_PUBLISHER_PRIVATE_KEY is read from
    $HOME\.near-credentials\testnet\oracle.gasx.testnet.json (private_key).
  - CRON_SECRET is a fresh random 48-byte Base64Url string.
  Both are written to the `production` and `preview` environments. Nothing
  secret is printed; only the variable names are. Redeploy afterwards for the
  new values to take effect.
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$credentialsPath = Join-Path $HOME '.near-credentials\testnet\oracle.gasx.testnet.json'
if (-not (Test-Path -LiteralPath $credentialsPath)) {
  throw "NEAR credentials file not found: $credentialsPath. Create the oracle.gasx.testnet key first (e.g. with the near CLI), then re-run this script."
}

$credentials = Get-Content -LiteralPath $credentialsPath -Raw | ConvertFrom-Json
if (-not ($credentials.PSObject.Properties.Name -contains 'private_key') -or [string]::IsNullOrWhiteSpace($credentials.private_key)) {
  throw "No private_key field in $credentialsPath."
}
$privateKey = [string]$credentials.private_key

$bytes = New-Object byte[] 48
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
$cronSecret = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')

$values = [ordered]@{
  GASX_NEAR_PUBLISHER_PRIVATE_KEY = $privateKey
  CRON_SECRET                     = $cronSecret
}

$set = @()
foreach ($environment in @('production', 'preview')) {
  foreach ($name in $values.Keys) {
    & vercel env add $name $environment --value $values[$name] --yes --force *> $null
    if ($LASTEXITCODE -ne 0) {
      throw "vercel env add failed for $name ($environment). Is the vercel CLI installed, logged in and linked (vercel link)?"
    }
    $set += "$name ($environment)"
  }
}

Write-Host 'Set Vercel environment variables:'
$set | ForEach-Object { Write-Host "  $_" }
Write-Host 'Redeploy (vercel --prod) so the new values take effect.'
