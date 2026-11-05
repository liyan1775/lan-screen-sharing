param(
  [string]$GoExe = '',
  [string]$GoProxy = '',
  [string]$BuildVersion = '0.5.0',
  [string]$OutputPath = ''
)
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($OutputPath)) { $OutputPath = Join-Path $ProjectRoot ("dist\局域网屏幕共享-$BuildVersion.exe") }
elseif (-not [IO.Path]::IsPathRooted($OutputPath)) { $OutputPath = Join-Path $ProjectRoot $OutputPath }
if ($BuildVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'BuildVersion must use semantic version form, for example 0.1.4.' }
. (Join-Path $PSScriptRoot 'resolve-go.ps1')
$GoExe = Resolve-GoExecutable $GoExe
$GoVersion = (& $GoExe version 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw "Unable to run Go: $GoVersion" }
New-Item -ItemType Directory -Force (Split-Path -Parent $OutputPath) | Out-Null
if ($GoProxy) { $env:GOPROXY = $GoProxy }
$env:GOOS = 'windows'
$env:GOARCH = 'amd64'
$env:CGO_ENABLED = '0'
Push-Location $ProjectRoot
try {
  & $GoExe build -trimpath -buildvcs=false -ldflags "-H windowsgui -X main.version=$BuildVersion" -o $OutputPath ./cmd/lan-screen-sharing
  if ($LASTEXITCODE -ne 0) { throw "Go build failed with exit code $LASTEXITCODE" }
} finally { Pop-Location }
if (-not (Test-Path -LiteralPath $OutputPath -PathType Leaf)) { throw 'Build reported success but output file is missing.' }
& (Join-Path $PSScriptRoot 'write-third-party-notices.ps1') -GoExe $GoExe -OutputPath ([IO.Path]::ChangeExtension($OutputPath, '.licenses.txt'))
Write-Output "Built candidate artifact: $OutputPath"
Write-Output "Build version: $BuildVersion"
Write-Output "Toolchain: $GoVersion"
