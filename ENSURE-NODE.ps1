# StudyDeck - downloads Node.js 24 LTS (Windows). Started by ENSURE-NODE.bat; not meant to be run by hand.
# Exit code 0 = ready, 1 = failed.
param([Parameter(Mandatory = $true)][string]$Target)
$ErrorActionPreference = 'Stop'
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $base = 'https://nodejs.org/dist/latest-v24.x'
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
  $sums = (Invoke-WebRequest -UseBasicParsing "$base/SHASUMS256.txt").Content -split "`n"
  $line = $sums | Where-Object { $_ -match "node-v[0-9.]+-win-$arch\.zip\s*$" } | Select-Object -First 1
  if (-not $line) { throw 'No Node.js download was found for this computer.' }
  $parts = $line.Trim() -split '\s+'
  $want = $parts[0]; $file = $parts[1]
  $tmp = Join-Path $env:TEMP ('studydeck-node-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  Write-Host "Downloading $file ..."
  $zip = Join-Path $tmp $file
  Invoke-WebRequest -UseBasicParsing "$base/$file" -OutFile $zip
  $got = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
  if ($got -ne $want.ToLower()) { throw 'The downloaded file did not match its fingerprint, so it was NOT used.' }
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $inner = Join-Path $tmp ($file -replace '\.zip$', '')
  if (Test-Path $Target) { Remove-Item -Recurse -Force $Target }
  New-Item -ItemType Directory -Path (Split-Path $Target) -Force | Out-Null
  Move-Item $inner $Target
  Remove-Item -Recurse -Force $tmp
  exit 0
} catch {
  Write-Host $_.Exception.Message
  exit 1
}
