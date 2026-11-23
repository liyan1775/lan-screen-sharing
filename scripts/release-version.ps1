function Assert-SemVer([string]$Version) {
  $number = '(?:0|[1-9][0-9]*)'
  $prerelease = "(?:$number|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)"
  $metadata = '[0-9A-Za-z-]+'
  if ($Version -cnotmatch "\A$number\.$number\.$number(?:-$prerelease(?:\.$prerelease)*)?(?:\+$metadata(?:\.$metadata)*)?\z") {
    throw "Invalid SemVer 2.0.0 version '$Version'. Examples: 1.0.0, 1.1.0-rc.1."
  }
}
