# StudyDeck - downloads a private copy of Node.js 24 (newest 24.x) from nodejs.org.
# Called by ENSURE-NODE.bat. Checks the file against nodejs.org's published checksum.
param([Parameter(Mandatory = $true)][string]$Dest)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'
$major = 24
try {
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'x64' }
  $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json'
  $entry = $index | Where-Object { $_.version -like "v$major.*" } | Select-Object -First 1
  if (-not $entry) { throw "No Node.js $major version found on nodejs.org." }
  $ver = $entry.version
  $name = "node-$ver-win-$arch"
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("studydeck-node-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  Write-Host "Downloading Node.js $ver ..."
  $zip = Join-Path $tmp 'node.zip'
  Invoke-WebRequest -Uri "https://nodejs.org/dist/$ver/$name.zip" -OutFile $zip
  $sums = (Invoke-WebRequest -Uri "https://nodejs.org/dist/$ver/SHASUMS256.txt").Content -split "`n"
  $line = $sums | Where-Object { $_ -match "\s$([regex]::Escape($name)).zip\s*$" } | Select-Object -First 1
  if ($line) {
    $want = ($line -split '\s+')[0].ToLower()
    $got = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLower()
    if ($want -ne $got) { throw 'The downloaded file is damaged (checksum mismatch). Nothing was installed.' }
  }
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  if (Test-Path $Dest) { Remove-Item -Recurse -Force $Dest }
  New-Item -ItemType Directory -Path (Split-Path $Dest -Parent) -Force | Out-Null
  Move-Item -Path (Join-Path $tmp $name) -Destination $Dest
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  Write-Host "Node.js $ver is ready."
  exit 0
} catch {
  Write-Host "Could not get Node.js: $($_.Exception.Message)"
  Write-Host 'Check your internet connection, or install Node.js (LTS) from https://nodejs.org'
  exit 1
}
