param(
  [Parameter(Mandatory=$true)][string]$ExePath,
  [Parameter(Mandatory=$true)][string]$Version,
  [Parameter(Mandatory=$true)][string]$ExpectedSha256,
  [Parameter(Mandatory=$true)][string]$GuideRoot,
  [string]$OutputRoot = ''
)
$ErrorActionPreference = 'Stop'
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'Version must have the form 0.3.0.' }
if ($ExpectedSha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'ExpectedSha256 must be a SHA-256 hex digest.' }
$exe = (Resolve-Path -LiteralPath $ExePath).Path
$guide = (Resolve-Path -LiteralPath $GuideRoot).Path
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'ExePath must be a file.' }
$hash = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash
if ($hash -ne $ExpectedSha256) { throw 'Executable hash does not match ExpectedSha256.' }
$names = @('先看这里.html', '快速上手.txt', '测试反馈.txt', '开源组件许可.txt')
foreach ($name in $names) { if (-not (Test-Path -LiteralPath (Join-Path $guide $name) -PathType Leaf)) { throw "Missing guide: $name" } }
if (-not ([IO.File]::ReadAllText((Join-Path $guide '先看这里.html')).Contains($Version))) { throw 'The guide must identify the requested version.' }
# --version exits before any networking, browser, or capture setup.
$versionStart = [Diagnostics.ProcessStartInfo]::new()
$versionStart.FileName = $exe
$versionStart.Arguments = '--version'
$versionStart.UseShellExecute = $false
$versionStart.CreateNoWindow = $true
$versionStart.RedirectStandardOutput = $true
$versionStart.RedirectStandardError = $true
$process = [Diagnostics.Process]::new()
$process.StartInfo = $versionStart
try {
  if (-not $process.Start()) { throw 'Executable version check could not start.' }
  if (-not $process.WaitForExit(10000)) { $process.Kill(); throw 'Executable version check timed out.' }
  $actualVersion = $process.StandardOutput.ReadToEnd().Trim()
  if ($process.ExitCode -ne 0 -or $actualVersion -ne $Version) { throw "Executable version does not match $Version (reported '$actualVersion')." }
} finally { $process.Dispose() }
if (-not $OutputRoot) { $OutputRoot = Join-Path (Split-Path -Parent $PSScriptRoot) 'dist' }
New-Item -ItemType Directory -Force -Path $OutputRoot | Out-Null
$packageName = "局域网屏幕共享-$Version-公开测试版"
$folder = Join-Path $OutputRoot $packageName
$zip = Join-Path $OutputRoot ($packageName + '.zip')
$checksum = $zip + '.sha256'
foreach ($path in @($folder,$zip,$checksum)) { if (Test-Path -LiteralPath $path) { throw "Output already exists: $path" } }
New-Item -ItemType Directory -Path $folder | Out-Null
Copy-Item -LiteralPath $exe -Destination (Join-Path $folder '局域网屏幕共享.exe')
foreach ($name in $names) {
  $source = Join-Path $guide $name
  $runtimeNotices = [IO.Path]::ChangeExtension($exe, '.licenses.txt')
  if ($name -eq '开源组件许可.txt' -and (Test-Path -LiteralPath $runtimeNotices -PathType Leaf)) { $source = $runtimeNotices }
  $content = [IO.File]::ReadAllText($source, [Text.Encoding]::UTF8) -replace '\r?\n', "`r`n"
  [IO.File]::WriteAllText((Join-Path $folder $name), $content, [Text.UTF8Encoding]::new($true))
}
$info = "局域网屏幕共享 $Version · 公开测试版`r`n程序 SHA-256：$hash`r`n"
[IO.File]::WriteAllText((Join-Path $folder '版本与校验.txt'), $info, [Text.UTF8Encoding]::new($true))
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($folder, $zip, [IO.Compression.CompressionLevel]::Optimal, $true)
$zipHash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash
[IO.File]::WriteAllText($checksum, "$zipHash  $([IO.Path]::GetFileName($zip))`r`n", [Text.UTF8Encoding]::new($true))
Write-Output "Package: $zip`nSHA-256: $zipHash"
