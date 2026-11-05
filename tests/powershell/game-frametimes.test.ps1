$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$TestRoot = Join-Path $ProjectRoot ('.superpowers\game capture test ' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $TestRoot -Force | Out-Null
$FakeTool = Join-Path $TestRoot 'fake-presentmon.exe'
Add-Type -TypeDefinition @'
using System;
using System.IO;
public class FakePresentMon {
  public static int Main(string[] args) {
    string output = null;
    for (int i = 0; i < args.Length; i++) if (args[i] == "--output_file" && i + 1 < args.Length) output = args[i + 1];
    if (String.IsNullOrEmpty(output) || Array.IndexOf(args, "--process_id") < 0 || Array.IndexOf(args, "--terminate_after_timed") < 0) return 7;
    File.WriteAllText(output, "Application,ProcessID,SwapChainAddress,MsBetweenPresents\r\ngame.exe,123,0x1,5\r\n");
    File.WriteAllLines(output + ".args", args);
    return 0;
  }
}
'@ -OutputAssembly $FakeTool -OutputType ConsoleApplication
$OutputRoot = Join-Path $TestRoot 'output with spaces'
& (Join-Path $ProjectRoot 'scripts\capture-game-frametimes.ps1') -PresentMonExe $FakeTool -GameProcessId $PID -Phase baseline -Run 1 -Seconds 60 -DelaySeconds 0 -OutputDirectory $OutputRoot
$Csv = Join-Path $OutputRoot 'baseline-1.csv'
$Metadata = Get-Content -Raw -LiteralPath (Join-Path $OutputRoot 'baseline-1.json') | ConvertFrom-Json
$Arguments = @(Get-Content -LiteralPath ($Csv + '.args') -Encoding UTF8)
if ($Arguments[$Arguments.IndexOf('--process_id') + 1] -ne [string]$PID) { throw 'Capture target PID changed.' }
if ($Arguments[$Arguments.IndexOf('--output_file') + 1] -ne $Csv) { throw 'Path with spaces did not arrive as one argument.' }
if ($Metadata.csvSHA256 -ne (Get-FileHash -LiteralPath $Csv -Algorithm SHA256).Hash) { throw 'Metadata CSV hash mismatch.' }
$Rejected = $false
try { & (Join-Path $ProjectRoot 'scripts\capture-game-frametimes.ps1') -PresentMonExe $FakeTool -GameProcessId $PID -Phase baseline -Run 1 -Seconds 60 -DelaySeconds 0 -OutputDirectory $OutputRoot }
catch { if ($_.Exception.Message -notmatch 'Recording already exists') { throw }; $Rejected = $true }
if (-not $Rejected) { throw 'Existing baseline was overwritten.' }
Write-Output 'Game frame capture wrapper passed: exact PID, bounded helper arguments, paths with spaces, hashes and overwrite refusal. This does not exercise real game ETW.'
