<#
  Sets the Vercel environment variables the cron tick needs.

  Run from the repo root (G:\near-hackathon-2026), after `vercel link`:
    .\scripts\setup-vercel-secrets.ps1            # sets the secrets
    .\scripts\setup-vercel-secrets.ps1 -DryRun    # checks everything, changes nothing

  - SILICA_NEAR_PUBLISHER_PRIVATE_KEY (the code also accepts the older
    GASX_NEAR_PUBLISHER_PRIVATE_KEY) is read from
    $HOME\.near-credentials\testnet\oracle.gasx.testnet.json (private_key);
    account ids keep the project's original name.
  - CRON_SECRET is a fresh random 48-byte Base64Url string.
  Both are written to the `production` and `preview` environments. Nothing
  secret is printed; only the variable names are. Redeploy afterwards for the
  new values to take effect.

  -DryRun: checks the CLI is found, logged in and linked, and that the key
  file exists, without reading the key or changing anything on Vercel.
#>
param([switch]$DryRun)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Always run against the repo root, where .vercel\project.json links the project.
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot '.vercel\project.json'))) {
  throw "This folder is not linked to a Vercel project ($repoRoot\.vercel\project.json is missing). Run: vercel link"
}

$credentialsPath = Join-Path $HOME '.near-credentials\testnet\oracle.gasx.testnet.json'
if (-not (Test-Path -LiteralPath $credentialsPath)) {
  throw "NEAR credentials file not found: $credentialsPath. Create the oracle.gasx.testnet key first (e.g. with the near CLI), then re-run this script."
}

# Find the vercel CLI even when npm's global folder is not on this shell's PATH.
$vercel = $null
$vercelArgsPrefix = @()
$found = Get-Command vercel -ErrorAction SilentlyContinue | Select-Object -First 1
if ($found) {
  $vercel = $found.Source
  # Prefer the .cmd shim: the .ps1 shim turns the CLI's stderr hints into errors.
  if ($vercel -like '*.ps1') {
    $shim = [IO.Path]::ChangeExtension($vercel, '.cmd')
    if (Test-Path -LiteralPath $shim) { $vercel = $shim }
  }
}

$npmDirs = @(
  $(if ($env:APPDATA) { Join-Path $env:APPDATA 'npm' }),
  (Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'npm'),
  (Join-Path $HOME 'AppData\Roaming\npm'),
  $(if ($env:USERPROFILE) { Join-Path $env:USERPROFILE 'AppData\Roaming\npm' })
) | Where-Object { $_ } | Select-Object -Unique

if (-not $vercel) {
  foreach ($dir in $npmDirs) {
    $cmd = Join-Path $dir 'vercel.cmd'
    if (Test-Path -LiteralPath $cmd) { $vercel = $cmd; break }
  }
}
if (-not $vercel) {
  # Last resort: run the CLI's entry file with node directly.
  $node = $null
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($nodeCmd) { $node = $nodeCmd.Source }
  elseif (Test-Path -LiteralPath 'C:\Program Files\nodejs\node.exe') { $node = 'C:\Program Files\nodejs\node.exe' }
  foreach ($dir in $npmDirs) {
    $entry = Join-Path $dir 'node_modules\vercel\dist\vc.js'
    if ($node -and (Test-Path -LiteralPath $entry)) { $vercel = $node; $vercelArgsPrefix = @($entry); break }
  }
}
if (-not $vercel) {
  Write-Host 'Looked for the vercel CLI in:'
  $npmDirs | ForEach-Object { Write-Host "  $_" }
  throw "vercel CLI not found. Install it with: npm i -g vercel"
}
Write-Host "Using vercel CLI: $vercel $vercelArgsPrefix"

# Runs the CLI without letting its stderr hints abort the script (Windows
# PowerShell 5.1 treats redirected native stderr as errors under 'Stop').
function Invoke-Vercel {
  param([switch]$Quiet, [Parameter(ValueFromRemainingArguments = $true)][string[]]$CliArgs)
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    if ($Quiet) { & $vercel @vercelArgsPrefix @CliArgs *> $null; return }
    & $vercel @vercelArgsPrefix @CliArgs 2>$null
  } finally {
    $ErrorActionPreference = $previous
  }
}

# Logged in? (whoami prints only the account name.)
$who = Invoke-Vercel whoami | Where-Object { $_ -is [string] -and $_.Trim() } | Select-Object -Last 1
if ($LASTEXITCODE -ne 0 -or -not $who) { throw 'The vercel CLI is not logged in. Run: vercel login' }
Write-Host "Logged in as: $who"

if ($DryRun) {
  Write-Host "Key file present: $credentialsPath (not read)"
  Write-Host 'Dry run OK: nothing was changed. Run again without -DryRun to set the secrets.'
  return
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
  SILICA_NEAR_PUBLISHER_PRIVATE_KEY = $privateKey
  CRON_SECRET                       = $cronSecret
}

$set = @()
foreach ($environment in @('production', 'preview')) {
  foreach ($name in $values.Keys) {
    Invoke-Vercel -Quiet env add $name $environment --value $values[$name] --yes --force
    if ($LASTEXITCODE -ne 0) {
      throw "vercel env add failed for $name ($environment)."
    }
    $set += "$name ($environment)"
  }
}

Write-Host 'Set Vercel environment variables:'
$set | ForEach-Object { Write-Host "  $_" }
Write-Host 'Done. Redeploy on Vercel so the new values take effect.'
