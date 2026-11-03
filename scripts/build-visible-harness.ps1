param(
  [string]$GoPath = 'D:\个人项目\.codex-tools\lan-screen-sharing-go\go\bin\go.exe'
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$buildDirectory = Join-Path $projectRoot '.superpowers\sdd\lan-screen-sharing\build'
if (-not (Test-Path -LiteralPath $GoPath -PathType Leaf)) { throw "Go executable not found: $GoPath" }
New-Item -ItemType Directory -Path $buildDirectory -Force | Out-Null
$buildTag = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N')
$buildArtifact = Join-Path $buildDirectory "visible-media-harness-$buildTag.test.exe"
if (Test-Path -LiteralPath $buildArtifact) { throw 'Refusing to overwrite an existing scratch test binary.' }

$previousProxy = $env:GOPROXY
$previousSumDB = $env:GOSUMDB
try {
  $env:GOPROXY = 'file:///D:/个人项目/.codex-tools/lan-screen-sharing-go/goproxy'
  $env:GOSUMDB = 'off'
  Push-Location $projectRoot
  try {
    & $GoPath test -c -o $buildArtifact ./internal/app
    if ($LASTEXITCODE -ne 0) { throw "Go test-binary compile failed with exit code $LASTEXITCODE" }
  } finally {
    Pop-Location
  }
  $artifactInfo = Get-Item -LiteralPath $buildArtifact
  $artifactHash = (Get-FileHash -LiteralPath $buildArtifact -Algorithm SHA256).Hash
  Write-Output "Harness test binary: $($artifactInfo.FullName)"
  Write-Output "Size: $($artifactInfo.Length)"
  Write-Output "SHA-256: $artifactHash"
} finally {
  $env:GOPROXY = $previousProxy
  $env:GOSUMDB = $previousSumDB
}
