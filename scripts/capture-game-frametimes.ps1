param(
  [Parameter(Mandatory = $true)][string]$PresentMonExe,
  [Parameter(Mandatory = $true)][ValidateRange(1, 2147483647)][int]$GameProcessId,
  [Parameter(Mandatory = $true)][ValidateSet('baseline', 'streaming')][string]$Phase,
  [ValidateRange(1, 99)][int]$Run = 1,
  [ValidateRange(60, 600)][int]$Seconds = 90,
  [ValidateRange(0, 120)][int]$DelaySeconds = 10,
  [string]$OutputDirectory = '.superpowers/game-low'
)
$ErrorActionPreference = 'Stop'
$ToolPath = (Resolve-Path -LiteralPath $PresentMonExe).Path
$GameProcess = Get-Process -Id $GameProcessId -ErrorAction Stop
$OutputRoot = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $OutputRoot -Force | Out-Null
$CsvPath = Join-Path $OutputRoot ("{0}-{1}.csv" -f $Phase, $Run)
$MetadataPath = Join-Path $OutputRoot ("{0}-{1}.json" -f $Phase, $Run)
if ((Test-Path -LiteralPath $CsvPath) -or (Test-Path -LiteralPath $MetadataPath)) { throw "Recording already exists; choose another Run or OutputDirectory: $CsvPath" }
$Arguments = @('--process_id', $GameProcessId, '--output_file', ('"' + $CsvPath + '"'), '--timed', $Seconds, '--delay', $DelaySeconds,
  '--terminate_after_timed', '--no_console_stats', '--no_track_input', '--no_track_gpu', '--no_track_display', '--v1_metrics',
  '--session_name', ('LanShareGameLow-' + [guid]::NewGuid().ToString('N')))
$Metadata = [ordered]@{
  phase = $Phase; run = $Run; requestedSeconds = $Seconds; delaySeconds = $DelaySeconds
  processId = $GameProcessId; processName = $GameProcess.ProcessName
  utc = [DateTime]::UtcNow.ToString('o'); presentMonSHA256 = (Get-FileHash -LiteralPath $ToolPath -Algorithm SHA256).Hash
  cpu = @(Get-CimInstance Win32_Processor | Select-Object Name, NumberOfLogicalProcessors)
  gpu = @(Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion)
}
Write-Output "Recording only PID $GameProcessId after $DelaySeconds seconds for $Seconds seconds. Return to the same warmed-up game scene."
$CaptureProcess = Start-Process -FilePath $ToolPath -ArgumentList $Arguments -WindowStyle Hidden -PassThru
try {
  if (-not $CaptureProcess.WaitForExit(($Seconds + $DelaySeconds + 30) * 1000)) { throw 'PresentMon did not finish its bounded capture.' }
  if ($CaptureProcess.ExitCode -ne 0) { throw "PresentMon exited with $($CaptureProcess.ExitCode). Use a PresentMon console build supporting the documented flags." }
  if (-not (Test-Path -LiteralPath $CsvPath -PathType Leaf)) { throw 'PresentMon produced no CSV; the game or ETW capture was unavailable.' }
  $Metadata.csvSHA256 = (Get-FileHash -LiteralPath $CsvPath -Algorithm SHA256).Hash
  $Metadata | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $MetadataPath -Encoding UTF8
  Write-Output "Saved $CsvPath"
} finally {
  if (-not $CaptureProcess.HasExited) { Stop-Process -Id $CaptureProcess.Id -Force }
}
