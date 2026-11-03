$ErrorActionPreference = 'Stop'
$starterPath = (Resolve-Path (Join-Path $PSScriptRoot '..\..\scripts\start-visible-media.ps1')).Path
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($starterPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw 'Starter PowerShell parse failed.' }

$starterSource = Get-Content -LiteralPath $starterPath -Raw
if ([regex]::Matches($starterSource, '\$deadline = \[DateTime\]::UtcNow\.AddSeconds\(30\)').Count -ne 1 -or
    $starterSource -notmatch 'while \(\[DateTime\]::UtcNow -lt \$deadline\)') {
  throw 'READY polling must use one absolute 30-second startup deadline.'
}

foreach ($name in @('Test-SafeHarnessLine', 'Get-ReadyPollAction', 'Stop-OwnedHarnessGracefully')) {
  $functionAst = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true) | Select-Object -First 1
  if ($null -eq $functionAst) { throw "Starter helper $name was not found." }
  . ([scriptblock]::Create($functionAst.Extent.Text))
}

$script:mockState = 'identity-unavailable'
function Get-OwnedState($Entry) { return $script:mockState }

$diagnostic = 'VISIBLE_HARNESS_ENV_DIAGNOSTIC role=viewer alias=viewer-1 present=true utf8_bytes=64 ascii_lower_hex=true decoded_bytes=32 decode_error_kind=none validator_ok=true'
$ready = 'VISIBLE_HARNESS_READY role=viewer URL=http://localhost:54467/__visible_test__/?role=viewer'
if (-not (Test-SafeHarnessLine $diagnostic)) { throw 'Valid safe owner diagnostic must pass the allowlist.' }
if (-not (Test-SafeHarnessLine $ready)) { throw 'Valid localhost READY must pass the allowlist.' }
if (Test-SafeHarnessLine 'VISIBLE_HARNESS_READY role=viewer URL=http://example.com:54467/__visible_test__/?role=viewer') { throw 'External READY URLs must remain outside the allowlist.' }
if (Test-SafeHarnessLine 'VISIBLE_HARNESS_ENV_DIAGNOSTIC role=viewer alias=viewer-1 ownerToken=secret') { throw 'Unstructured diagnostic values must remain outside the allowlist.' }

$firstPoll = Get-ReadyPollAction 'identity-unavailable' $false $false
$secondPoll = Get-ReadyPollAction 'owned-running' $true $true
if ($firstPoll -ne 'continue' -or $secondPoll -ne 'ready') { throw 'A transient identity read failure followed by a valid same-run viewer READY must continue and succeed.' }
if ((Get-ReadyPollAction 'identity-unavailable' $true $true) -ne 'continue') { throw 'READY logs alone must not bypass owned process identity validation.' }
if ((Get-ReadyPollAction 'exited' $true $true) -ne 'stop') { throw 'An exited process must stop READY polling.' }
if ((Get-ReadyPollAction 'identity-mismatch' $true $true) -ne 'stop') { throw 'A mismatched process identity must stop READY polling.' }

$persistentUnavailableActions = @(1..150 | ForEach-Object { Get-ReadyPollAction 'identity-unavailable' $false $false })
if (@($persistentUnavailableActions | Where-Object { $_ -ne 'continue' }).Count -ne 0) { throw 'Persistent identity unavailability must consume the existing bounded wait rather than become READY or cleanup authorization.' }
$entryWithoutValidatedReady = [pscustomobject]@{ Process = $null; ReadyUri = $null }
$cleanupResult = Stop-OwnedHarnessGracefully $entryWithoutValidatedReady
if ($cleanupResult -ne 'identity-unavailable') { throw 'Persistent identity unavailability must not request nonce cleanup.' }
$script:mockState = 'owned-running'
if ((Stop-OwnedHarnessGracefully $entryWithoutValidatedReady) -ne 'residual-no-valid-ready-url') { throw 'A process without a validated READY URL must not receive a shutdown request.' }

Write-Output 'Visible-media starter pure helper regression passed; no service or process was started.'
