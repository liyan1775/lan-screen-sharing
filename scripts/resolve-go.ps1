function Resolve-GoExecutable([string]$ExplicitGoExe) {
  if ($ExplicitGoExe) {
    $command = Get-Command $ExplicitGoExe -ErrorAction SilentlyContinue
    if (-not $command) { throw "Go executable not found: $ExplicitGoExe" }
    return $command.Source
  }
  $command = Get-Command go -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  $cache = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) '.codex-tools/lan-screen-sharing-go/go/bin/go.exe'
  if (Test-Path -LiteralPath $cache -PathType Leaf) { return $cache }
  throw 'Go was not found. Install the version required by go.mod, add it to PATH, or provide -GoExe.'
}
