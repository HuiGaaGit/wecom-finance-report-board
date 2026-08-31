param([string]$OutputDirectory = "artifacts")
$ErrorActionPreference = "Stop"
$projectDirectory = Split-Path -Parent $PSScriptRoot
$package = Get-Content -Raw -LiteralPath (Join-Path $projectDirectory "package.json") | ConvertFrom-Json
$absoluteOutput = Join-Path $projectDirectory $OutputDirectory
New-Item -ItemType Directory -Force -Path $absoluteOutput | Out-Null
$staging = Join-Path ([System.IO.Path]::GetTempPath()) ("wecom-finance-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $staging | Out-Null
try {
  foreach ($name in @("app.mjs", "package.json", "package-lock.json", "README.md")) { Copy-Item -LiteralPath (Join-Path $projectDirectory $name) -Destination $staging }
  foreach ($name in @("public", "deploy")) { Copy-Item -Recurse -LiteralPath (Join-Path $projectDirectory $name) -Destination $staging }
  $artifact = Join-Path $absoluteOutput ("wecom-finance-report-board-" + $package.version + ".zip")
  if (Test-Path -LiteralPath $artifact) { throw "产物已存在，请先确认旧版本或更换输出目录：$artifact" }
  Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $artifact -CompressionLevel Optimal
  Write-Output $artifact
}
finally {
  if ((Resolve-Path -LiteralPath $staging).Path.StartsWith([System.IO.Path]::GetTempPath(), [System.StringComparison]::OrdinalIgnoreCase)) { Remove-Item -Recurse -Force -LiteralPath $staging }
}
