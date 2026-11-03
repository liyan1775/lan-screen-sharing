$ErrorActionPreference = 'Stop'

# Human-operated, synthetic-media fixture only. Do not use this script to launch a browser.
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$binary = Join-Path $projectRoot '.superpowers\sdd\lan-screen-sharing\build\visible-media-harness-0.1.4-3fbc2ab-e24fa89.test.exe'
$expectedHash = '66477C3E444271BEB15C3247F82F023E82D384B1FDDF8FADE60BEF8487DF6951'
$expectedBytes = 13128704L

if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) {
  throw 'The pinned visible-harness test binary is missing. Build or provide the exact candidate artifact before running this script.'
}
$binaryInfo = Get-Item -LiteralPath $binary
$actualHash = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash
if ($binaryInfo.Length -ne $expectedBytes -or $actualHash -ne $expectedHash) {
  throw 'The visible-harness test binary does not match the pinned candidate size and SHA-256.'
}

$buildDirectory = Split-Path -Parent $binary
$runId = [Guid]::NewGuid().ToString('N')
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$tokenBytes = New-Object byte[] 32
$rng.GetBytes($tokenBytes)
$ownerToken = ([BitConverter]::ToString($tokenBytes).Replace('-', '')).ToLowerInvariant()
[Array]::Clear($tokenBytes, 0, $tokenBytes.Length)
$rng.Dispose()

$roles = @(
  [pscustomobject]@{ Role = 'host'; Alias = 'host' },
  [pscustomobject]@{ Role = 'viewer'; Alias = 'viewer-1' },
  [pscustomobject]@{ Role = 'viewer'; Alias = 'viewer-2' },
  [pscustomobject]@{ Role = 'viewer'; Alias = 'viewer-extra' }
)
$owned = [System.Collections.Generic.List[object]]::new()
$readyComplete = $false

function Read-SafeHarnessLines([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return @() }
  return @(Get-Content -LiteralPath $Path -ErrorAction SilentlyContinue | Where-Object { Test-SafeHarnessLine $_ })
}

function Test-SafeHarnessLine([string]$Line) {
  return $Line -match '^VISIBLE_HARNESS_ENV_DIAGNOSTIC (role=(host|viewer) alias=(host|viewer-1|viewer-2|viewer-extra) present=(true|false) utf8_bytes=\d+ ascii_lower_hex=(true|false) decoded_bytes=\d+ decode_error_kind=(none|odd_length|invalid_byte) validator_ok=(true|false))$' -or
    $Line -match '^VISIBLE_HARNESS_READY role=(host|viewer) URL=http://localhost:\d+/__visible_test__/\?role=(host|viewer)$'
}

function Get-ReadyPollAction([string]$State, [bool]$HasDiagnostic, [bool]$HasReady) {
  if ($State -eq 'exited' -or $State -eq 'identity-mismatch') { return 'stop' }
  if ($State -eq 'owned-running' -and $HasDiagnostic -and $HasReady) { return 'ready' }
  return 'continue'
}

function Get-OwnedState($Entry) {
  try {
    $Entry.Process.Refresh()
    if ($Entry.Process.HasExited) { return 'exited' }
    $startedAt = $Entry.Process.StartTime.ToUniversalTime().Ticks
    $imagePath = $Entry.Process.MainModule.FileName
    if ($startedAt -ne $Entry.StartTimeUtcTicks -or
        -not [string]::Equals([IO.Path]::GetFullPath($imagePath), [IO.Path]::GetFullPath($binary), [StringComparison]::OrdinalIgnoreCase)) {
      return 'identity-mismatch'
    }
    return 'owned-running'
  } catch {
    return 'identity-unavailable'
  }
}

function Recover-ValidatedReadyUri($Entry) {
  $readyLine = Read-SafeHarnessLines $Entry.StdoutPath | Where-Object { $_ -match '^VISIBLE_HARNESS_READY ' } | Select-Object -Last 1
  if (-not $readyLine -or $readyLine -notmatch "^VISIBLE_HARNESS_READY role=$($Entry.Role) URL=http://localhost:\d+/__visible_test__/\?role=$($Entry.Role)$") { return $null }
  $urlText = ($readyLine -replace '^VISIBLE_HARNESS_READY role=(host|viewer) URL=', '')
  try { $uri = [Uri]::new($urlText) } catch { return $null }
  if ($uri.Host -ne 'localhost' -or $uri.Scheme -ne 'http' -or $uri.Port -le 0 -or $uri.AbsolutePath -ne '/__visible_test__/' -or $uri.Query -ne "?role=$($Entry.Role)") { return $null }
  return $uri
}

function Stop-OwnedHarnessGracefully($Entry) {
  $state = Get-OwnedState $Entry
  if ($state -eq 'exited') { return 'already-exited' }
  if ($state -ne 'owned-running') { return $state }
  if (-not $Entry.ReadyUri) { return 'residual-no-valid-ready-url' }

  $baseOrigin = $Entry.ReadyUri.GetLeftPart([UriPartial]::Authority)
  $controlToken = $null
  try {
    $bootstrap = Invoke-RestMethod -Method Get -Uri "$baseOrigin/api/v1/bootstrap?role=$($Entry.Role)" -Headers @{ Origin = $baseOrigin } -TimeoutSec 3
    $controlToken = [string]$bootstrap.localControlToken
    if ([string]::IsNullOrWhiteSpace($controlToken)) { return 'residual-no-local-control-nonce' }
    $response = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "$baseOrigin/api/v1/shutdown" -Headers @{ Origin = $baseOrigin; 'X-Local-Control-Token' = $controlToken } -TimeoutSec 3
    if ($response.StatusCode -ne 202) { return 'residual-shutdown-not-accepted' }
    if ($Entry.Process.WaitForExit(7000)) { return 'shutdown-exited' }
    return 'residual-after-accepted-shutdown'
  } catch {
    return 'residual-nonce-shutdown-failed'
  } finally {
    $controlToken = $null
    $bootstrap = $null
  }
}

try {
  foreach ($spec in $roles) {
    $stdoutPath = Join-Path $buildDirectory "visible-media-$runId-$($spec.Alias).stdout.log"
    $stderrPath = Join-Path $buildDirectory "visible-media-$runId-$($spec.Alias).stderr.log"
    $environmentValues = @{
      LANSW_VISIBLE_HARNESS = '1'
      LANSW_HARNESS_ROLE = $spec.Role
      LANSW_HARNESS_ALIAS = $spec.Alias
      LANSW_HARNESS_OWNER_TOKEN = $ownerToken
    }
    $previousEnvironmentValues = @{}
    foreach ($name in $environmentValues.Keys) {
      $previousEnvironmentValues[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    }
    try {
      foreach ($name in $environmentValues.Keys) {
        [Environment]::SetEnvironmentVariable($name, [string]$environmentValues[$name], 'Process')
      }
      $process = Start-Process -FilePath $binary `
        -ArgumentList @('-test.run=^TestVisibleHarnessRunner$', '-test.v') `
        -WorkingDirectory $projectRoot -WindowStyle Hidden `
        -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
    } finally {
      foreach ($name in $previousEnvironmentValues.Keys) {
        [Environment]::SetEnvironmentVariable($name, $previousEnvironmentValues[$name], 'Process')
      }
      $previousEnvironmentValues.Clear()
      $environmentValues.Clear()
    }
    $entry = [pscustomobject]@{
      Process = $process
      PID = $process.Id
      StartTimeUtcTicks = $process.StartTime.ToUniversalTime().Ticks
      Role = $spec.Role
      Alias = $spec.Alias
      StdoutPath = $stdoutPath
      StderrPath = $stderrPath
      ReadyUri = $null
    }
    $owned.Add($entry)

    Write-Output "Started owned fixture role=$($entry.Role) alias=$($entry.Alias) PID=$($entry.PID). Waiting for READY."
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    $safeLines = @()
    $pollStateCounts = [ordered]@{ ownedRunning = 0; identityUnavailable = 0; exited = 0; identityMismatch = 0; other = 0 }
    while ([DateTime]::UtcNow -lt $deadline) {
      $state = Get-OwnedState $entry
      switch ($state) {
        'owned-running' { $pollStateCounts.ownedRunning++ }
        'identity-unavailable' { $pollStateCounts.identityUnavailable++ }
        'exited' { $pollStateCounts.exited++ }
        'identity-mismatch' { $pollStateCounts.identityMismatch++ }
        default { $pollStateCounts.other++ }
      }
      $safeLines = Read-SafeHarnessLines $entry.StdoutPath
      $diagnostic = $safeLines | Where-Object { $_ -match '^VISIBLE_HARNESS_ENV_DIAGNOSTIC ' } | Select-Object -Last 1
      $readyLine = $safeLines | Where-Object { $_ -match '^VISIBLE_HARNESS_READY ' } | Select-Object -Last 1
      $pollAction = Get-ReadyPollAction $state ([bool]$diagnostic) ([bool]$readyLine)
      if ($pollAction -eq 'ready') {
        if ($diagnostic -notmatch "role=$($spec.Role) alias=$($spec.Alias) present=true utf8_bytes=64 ascii_lower_hex=true decoded_bytes=32 decode_error_kind=none validator_ok=true") {
          throw "Safe owner-token validation diagnostic failed for role=$($spec.Role) alias=$($spec.Alias)."
        }
        if ($readyLine -notmatch "^VISIBLE_HARNESS_READY role=$($spec.Role) URL=http://localhost:\d+/__visible_test__/\?role=$($spec.Role)$") {
          throw "READY URL or role did not match the expected localhost fixture for alias=$($spec.Alias)."
        }
        $urlText = ($readyLine -replace '^VISIBLE_HARNESS_READY role=(host|viewer) URL=', '')
        $readyUri = [Uri]::new($urlText)
        if ($readyUri.Host -ne 'localhost' -or $readyUri.Scheme -ne 'http' -or $readyUri.Port -le 0 -or $readyUri.AbsolutePath -ne '/__visible_test__/' -or $readyUri.Query -ne "?role=$($spec.Role)") {
          throw "READY URL failed localhost/path/role validation for alias=$($spec.Alias)."
        }
        $entry.ReadyUri = $readyUri
        break
      }
      if ($pollAction -eq 'stop') { break }
      Start-Sleep -Milliseconds 200
    }
    if (-not $entry.ReadyUri) {
      $safeSummary = if ($safeLines.Count) { $safeLines -join ' | ' } else { 'no allowlisted diagnostic or READY lines' }
      $stateSummary = "owned-running=$($pollStateCounts.ownedRunning),identity-unavailable=$($pollStateCounts.identityUnavailable),exited=$($pollStateCounts.exited),identity-mismatch=$($pollStateCounts.identityMismatch),other=$($pollStateCounts.other)"
      throw "Fixture failed before a valid READY for role=$($spec.Role) alias=$($spec.Alias) PID=$($entry.PID); ownedState=$(Get-OwnedState $entry); pollStates=$stateSummary; safeLog=$safeSummary"
    }
    Write-Output "Verified READY role=$($entry.Role) alias=$($entry.Alias) PID=$($entry.PID) URL=$($entry.ReadyUri.AbsoluteUri) pollStates=owned-running:$($pollStateCounts.ownedRunning),identity-unavailable:$($pollStateCounts.identityUnavailable)"
  }

  $readyComplete = $true
  Write-Output "All four synthetic-media fixtures are READY. Binary SHA-256: $actualHash"
  Write-Output 'The product page startup grace is 30 seconds; only this test fixture overrides its startup grace to 45 minutes. Product last-tab shutdown behavior remains enabled.'
  Write-Output 'Open the printed localhost URLs manually in the intended CUA session. This script does not launch or control a browser or capture devices.'
  Write-Output 'Waiting for all four owned test processes to exit. Press Ctrl+C to request nonce-protected graceful shutdown of remaining owned fixtures.'

  while ($true) {
    $running = @($owned | Where-Object { (Get-OwnedState $_) -eq 'owned-running' })
    if ($running.Count -eq 0) { break }
    Start-Sleep -Milliseconds 500
  }
} finally {
  foreach ($entry in $owned) {
    if (-not $entry.ReadyUri) { $entry.ReadyUri = Recover-ValidatedReadyUri $entry }
    $cleanup = Stop-OwnedHarnessGracefully $entry
    if ($cleanup -like 'residual-*') {
      Write-Warning "Fixture cleanup needs human attention: role=$($entry.Role) alias=$($entry.Alias) ownedPID=$($entry.PID) status=$cleanup. No unknown process was terminated."
    }
  }
  $ownerToken = $null
  [Array]::Clear($tokenBytes, 0, $tokenBytes.Length)
  if (-not $readyComplete) {
    Write-Warning 'Startup did not produce four valid READY records; only records with an authenticated localhost nonce were shut down. Check the reported owned PIDs before manual cleanup.'
  }
}
