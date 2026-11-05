param(
  [Parameter(Mandatory=$true)][string]$OutputPath,
  [string]$GoExe = ''
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'resolve-go.ps1')
$GoExe = Resolve-GoExecutable $GoExe
$sections = [Collections.Generic.List[string]]::new()
$sections.Add('LAN Screen Sharing - third-party notices')
$sections.Add('Generated from the runtime dependencies of ./cmd/lan-screen-sharing. Development and test tools are not distributed in the executable.')
function Add-Notice([string]$Label, [string]$SourcePath) {
  $sections.Add("================================================================`n$Label`n================================================================`n`n" + [IO.File]::ReadAllText($SourcePath, [Text.Encoding]::UTF8).TrimEnd())
}
Push-Location $projectRoot
try {
  $rows = & $GoExe list -deps -f '{{if .Module}}{{.Module.Path}}|{{.Module.Version}}|{{.Module.Dir}}{{end}}' ./cmd/lan-screen-sharing
  if ($LASTEXITCODE -ne 0) { throw 'Could not enumerate runtime module notices.' }
  foreach ($row in ($rows | Where-Object { $_ -and $_ -notmatch '^lan-screen-sharing\|' } | Sort-Object -Unique)) {
    $parts = $row -split '\|', 3
    $notices = @(Get-ChildItem -LiteralPath $parts[2] -File | Where-Object { $_.Name -match '^(LICENSE|NOTICE|COPYING|PATENTS)(\.|$)' } | Sort-Object Name)
    if (-not ($notices | Where-Object { $_.Name -match '^(LICENSE|COPYING)(\.|$)' })) { throw "No license found for $($parts[0])." }
    foreach ($notice in $notices) { Add-Notice "$($parts[0]) $($parts[1]) - $($notice.Name)" $notice.FullName }
  }
  $runtimeRoot = (& $GoExe env GOROOT).Trim()
  if ($LASTEXITCODE -ne 0) { throw 'Could not locate Go runtime notices.' }
  foreach ($name in @('LICENSE','PATENTS')) { Add-Notice "Go runtime / standard library - $name" (Join-Path $runtimeRoot $name) }
  Add-Notice 'Phosphor Icons 2.1.1 - MIT License' (Join-Path $projectRoot 'internal/web/assets/PHOSPHOR-LICENSE.txt')
  if (-not [IO.Path]::IsPathRooted($OutputPath)) { $OutputPath = Join-Path $projectRoot $OutputPath }
  New-Item -ItemType Directory -Force (Split-Path -Parent $OutputPath) | Out-Null
  [IO.File]::WriteAllText($OutputPath, (($sections -join "`n`n") -replace '\r?\n', "`r`n") + "`r`n", [Text.UTF8Encoding]::new($false))
  Write-Output "Third-party notices: $OutputPath"
} finally { Pop-Location }
