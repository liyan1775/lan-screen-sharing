param(
  [string]$GoExe = '',
  [string]$GoProxy = '',
  [switch]$BrowserE2E
)
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Push-Location $ProjectRoot
try {
  . (Join-Path $PSScriptRoot 'resolve-go.ps1')
  $GoExe = Resolve-GoExecutable $GoExe
  if ($GoProxy) { $env:GOPROXY = $GoProxy }
  $env:GOOS = 'windows'
  $env:GOARCH = 'amd64'
  $env:CGO_ENABLED = '0'
  $NodeVersion = (& node --version 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $NodeVersion -notmatch '^v24\.') { throw "Expected Node.js 24; got: $NodeVersion" }
  Write-Output "Node toolchain: $NodeVersion"
  Write-Output 'Running Go tests...'
  & $GoExe test ./... -count=1
  if ($LASTEXITCODE -ne 0) { throw "Go tests failed with exit code $LASTEXITCODE" }
  Write-Output 'Running Node behavior tests...'
  & node --test tests/js/*.test.js
  if ($LASTEXITCODE -ne 0) { throw "Node tests failed with exit code $LASTEXITCODE" }
  Write-Output 'Checking E2E scripts and fixture logic (no browser launch)...'
  & node --check tests/e2e/fixtures/synthetic-media.js
  if ($LASTEXITCODE -ne 0) { throw 'Synthetic media fixture syntax check failed.' }
  & node --check tests/e2e/fixtures/services.js
  if ($LASTEXITCODE -ne 0) { throw 'Service fixture syntax check failed.' }
  & node --check tests/e2e/fixtures/services.test.js
  if ($LASTEXITCODE -ne 0) { throw 'Server-only fixture test syntax check failed.' }
  & node --check tests/e2e/mesh.spec.js
  if ($LASTEXITCODE -ne 0) { throw 'Browser E2E syntax check failed.' }
  & node --test tests/e2e/fixtures/synthetic-media.test.js
  if ($LASTEXITCODE -ne 0) { throw 'Synthetic media fixture logic tests failed.' }
  & node --input-type=module -e "import { chromium } from 'playwright-core'; if (!chromium) process.exit(1); console.log('playwright-core imported; browser not launched')"
  if ($LASTEXITCODE -ne 0) { throw 'playwright-core import failed.' }
  Write-Output 'Building Windows amd64 GUI executable...'
  $Artifact = Join-Path $ProjectRoot ("dist\verify-" + [guid]::NewGuid().ToString() + ".exe")
  & (Join-Path $PSScriptRoot 'build.ps1') -GoExe $GoExe -GoProxy $GoProxy -OutputPath $Artifact
  if ($LASTEXITCODE -ne 0) { throw "Build script failed with exit code $LASTEXITCODE" }
  if (-not (Test-Path -LiteralPath $Artifact -PathType Leaf)) { throw "Artifact missing: $Artifact" }
  $Bytes = [IO.File]::ReadAllBytes($Artifact)
  if ($Bytes.Length -lt 256 -or $Bytes[0] -ne 0x4d -or $Bytes[1] -ne 0x5a) { throw 'Output is not a valid PE executable.' }
  $PeOffset = [BitConverter]::ToInt32($Bytes, 0x3c)
  if ($PeOffset -lt 64 -or $PeOffset + 6 -gt $Bytes.Length) { throw 'Invalid PE header offset.' }
  if ($Bytes[$PeOffset] -ne 0x50 -or $Bytes[$PeOffset + 1] -ne 0x45 -or $Bytes[$PeOffset + 2] -ne 0 -or $Bytes[$PeOffset + 3] -ne 0) { throw 'PE signature missing.' }
  $Machine = [BitConverter]::ToUInt16($Bytes, $PeOffset + 4)
  if ($Machine -ne 0x8664) { throw ('Expected amd64 PE machine 0x8664; got 0x{0:X4}' -f $Machine) }
  Write-Output ("Verified amd64 PE: {0} bytes; SHA256 {1}" -f $Bytes.Length, (Get-FileHash -LiteralPath $Artifact -Algorithm SHA256).Hash)
  Write-Output 'Running --open-browser=false server-only process smoke...'
  $PortProbe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  $PortProbe.Start()
  $SmokePort = $PortProbe.LocalEndpoint.Port
  $PortProbe.Stop()
  $SmokeProcess = $null
  try {
    $SmokeProcess = Start-Process -FilePath $Artifact -ArgumentList @('--open-browser=false', "--port=$SmokePort") -PassThru -WindowStyle Hidden
    $BaseUrl = "http://localhost:$SmokePort"
    $Bootstrap = $null
    $Deadline = (Get-Date).AddSeconds(12)
    while ((Get-Date) -lt $Deadline -and $null -eq $Bootstrap) {
      if ($SmokeProcess.HasExited) { throw "Test-owned EXE exited before bootstrap (exit $($SmokeProcess.ExitCode))." }
      try {
        $Response = Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/api/v1/bootstrap" -Headers @{ Origin = $BaseUrl } -TimeoutSec 2
        if ($Response.StatusCode -eq 200) { $Bootstrap = $Response.Content | ConvertFrom-Json }
      } catch { Start-Sleep -Milliseconds 100 }
    }
    if ($null -eq $Bootstrap -or -not $Bootstrap.localControlToken) { throw 'Server-only smoke did not return a local control token.' }
    $Shutdown = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "$BaseUrl/api/v1/shutdown" -Headers @{ Origin = $BaseUrl; 'X-Local-Control-Token' = $Bootstrap.localControlToken } -TimeoutSec 3
    if ($Shutdown.StatusCode -ne 202) { throw "Shutdown endpoint returned $($Shutdown.StatusCode), expected 202." }
    if (-not $SmokeProcess.WaitForExit(5000)) { throw 'Test-owned EXE did not exit after authorized shutdown.' }
    if ($SmokeProcess.ExitCode -ne 0) { throw "Test-owned EXE exited with $($SmokeProcess.ExitCode)." }
    Write-Output "Server-only smoke passed: bootstrap 200; authorized shutdown 202; owned PID $($SmokeProcess.Id) exited 0. No browser launched."
  } finally {
    if ($null -ne $SmokeProcess -and -not $SmokeProcess.HasExited) { Stop-Process -Id $SmokeProcess.Id -Force -ErrorAction SilentlyContinue }
  }
  Write-Output 'Running test-owned multi-service shutdown fixture (no browser launch)...'
  & node --test tests/e2e/fixtures/services.test.js
  if ($LASTEXITCODE -ne 0) { throw 'Test-owned multi-service fixture failed.' }
  if ($BrowserE2E) {
    if (-not $env:LANSW_EXE) { $env:LANSW_EXE = $Artifact }
    if (-not $env:LANSW_BROWSER_PATH) { throw 'BrowserE2E requires LANSW_BROWSER_PATH pointing to a permitted Chromium or Edge executable.' }
    Write-Output 'Running explicit three-context browser E2E...'
    & node --test tests/e2e/mesh.spec.js
    if ($LASTEXITCODE -ne 0) { throw "Browser E2E failed with exit code $LASTEXITCODE" }
  } else {
    Write-Output 'E2E NOT RUN (BrowserE2E not requested)'
  }
  Write-Output 'Automated verification complete. Real device media acceptance remains separate.'
} finally { Pop-Location }
