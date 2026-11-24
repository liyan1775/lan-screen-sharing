param(
  [Parameter(Mandatory=$true)][string]$ExePath,
  [string]$Version = '1.1.1',
  [string]$OutputRoot = ''
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'release-version.ps1')
Assert-SemVer $Version
$projectRoot = Split-Path -Parent $PSScriptRoot
$exe = (Resolve-Path -LiteralPath $ExePath).Path
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'ExePath must be a file.' }
$thirdParty = [IO.Path]::ChangeExtension($exe, '.licenses.txt')
if (-not (Test-Path -LiteralPath $thirdParty -PathType Leaf)) {
  throw 'The executable is missing its generated third-party notices. Build it with scripts/build.ps1.'
}

# Redirect stdout because the Windows GUI executable does not attach to the shell.
$start = [Diagnostics.ProcessStartInfo]::new()
$start.FileName = $exe
$start.Arguments = '--version'
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.RedirectStandardOutput = $true
$process = [Diagnostics.Process]::Start($start)
try {
  if (-not $process.WaitForExit(10000)) { $process.Kill(); throw 'Executable version check timed out.' }
  $actualVersion = $process.StandardOutput.ReadToEnd().TrimEnd("`r", "`n")
  if ($process.ExitCode -ne 0 -or $actualVersion -cne $Version) {
    throw "Executable version does not match $Version (reported '$actualVersion')."
  }
} finally { $process.Dispose() }

if (-not $OutputRoot) { $OutputRoot = Join-Path $projectRoot "dist/release-$Version" }
New-Item -ItemType Directory -Force -Path $OutputRoot | Out-Null
$folder = (Resolve-Path -LiteralPath $OutputRoot).Path
$exeName = "局域网屏幕共享-$Version.exe"
$zipName = "lan-screen-sharing-$Version-windows-x64.zip"
$releaseExe = Join-Path $folder $exeName
$zip = Join-Path $folder $zipName
$checksums = Join-Path $folder 'SHA256SUMS.txt'
foreach ($path in @($zip, $checksums)) {
  if (Test-Path -LiteralPath $path) { throw "Release output already exists: $path" }
}

$exeHash = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
$guide = [IO.File]::ReadAllText((Join-Path $projectRoot 'docs/release-guide.html'))
$channel = if (($Version -split '\+', 2)[0].Contains('-')) { '预发版' } else { '正式版' }
$guide = $guide.Replace('{{VERSION}}', $Version).Replace('{{CHANNEL}}', $channel)
$utf8 = [Text.UTF8Encoding]::new($false)
$staging = Join-Path $folder ('.pack-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $staging | Out-Null
try {
  $stagedExe = Join-Path $staging $exeName
  if (Test-Path -LiteralPath $releaseExe) {
    if ((Get-FileHash -LiteralPath $releaseExe -Algorithm SHA256).Hash -ne $exeHash) {
      throw "A different executable already exists at $releaseExe."
    }
  } else {
    [IO.File]::Copy($exe, $stagedExe)
  }

  $guidePath = Join-Path $staging '先看这里.html'
  $infoPath = Join-Path $staging '版本与校验.txt'
  [IO.File]::WriteAllText($guidePath, $guide, $utf8)
  [IO.File]::WriteAllText($infoPath, "LAN / 分享 · v$Version $channel · Windows x64`r`n局域网屏幕共享.exe  SHA-256`r`n$exeHash`r`n", $utf8)
  $entries = [ordered]@{
    '局域网屏幕共享.exe' = $exe
    '先看这里.html' = $guidePath
    'LICENSE' = (Join-Path $projectRoot 'LICENSE')
    'NOTICE' = (Join-Path $projectRoot 'NOTICE')
    '开源组件许可.txt' = $thirdParty
    '版本与校验.txt' = $infoPath
  }
  Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
  $stagedZip = Join-Path $staging $zipName
  $archive = [IO.Compression.ZipFile]::Open($stagedZip, [IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach ($entry in $entries.GetEnumerator()) {
      [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $entry.Value, $entry.Key, [IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
  } finally { $archive.Dispose() }
  $zipHash = (Get-FileHash -LiteralPath $stagedZip -Algorithm SHA256).Hash.ToLowerInvariant()
  $stagedChecksums = Join-Path $staging 'SHA256SUMS.txt'
  [IO.File]::WriteAllText($stagedChecksums, "$exeHash  $exeName`n$zipHash  $zipName`n", $utf8)
  if (Test-Path -LiteralPath $stagedExe) { [IO.File]::Move($stagedExe, $releaseExe) }
  [IO.File]::Move($stagedZip, $zip)
  [IO.File]::Move($stagedChecksums, $checksums)
} finally {
  foreach ($name in @($exeName, $zipName, 'SHA256SUMS.txt', '先看这里.html', '版本与校验.txt')) {
    $path = Join-Path $staging $name
    if (Test-Path -LiteralPath $path -PathType Leaf) { Remove-Item -LiteralPath $path -Force }
  }
  Remove-Item -LiteralPath $staging
}

Write-Output "Version: $actualVersion`nExecutable: $releaseExe`nPackage: $zip`nChecksums: $checksums"
