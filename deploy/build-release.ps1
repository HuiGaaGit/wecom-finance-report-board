param([string]$OutputDirectory = "artifacts")
$ErrorActionPreference = "Stop"
$projectDirectory = Split-Path -Parent $PSScriptRoot
$package = Get-Content -Raw -LiteralPath (Join-Path $projectDirectory "package.json") | ConvertFrom-Json
$absoluteOutput = Join-Path $projectDirectory $OutputDirectory
New-Item -ItemType Directory -Force -Path $absoluteOutput | Out-Null
$staging = Join-Path ([System.IO.Path]::GetTempPath()) ("wecom-finance-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $staging | Out-Null
try {
  foreach ($name in @(".dockerignore", "Dockerfile", "app.mjs", "app.test.mjs", "asset-liability-analysis.mjs", "asset-liability-analysis.test.mjs", "permission-center.test.mjs", "platform-auth.mjs", "platform-auth.test.mjs", "package.json", "package-lock.json", "README.md")) { Copy-Item -LiteralPath (Join-Path $projectDirectory $name) -Destination $staging }
  foreach ($name in @("public", "deploy", "docs")) { Copy-Item -Recurse -LiteralPath (Join-Path $projectDirectory $name) -Destination $staging }
  # The same-origin package excludes retired standalone-domain bridge files.
  foreach ($name in @("deploy\nginx\finance-origin.conf", "deploy\nginx\finance-auth-bridge.html", "deploy\nginx\finance-auth-bridge.js")) {
    Remove-Item -LiteralPath (Join-Path $staging $name) -Force -ErrorAction SilentlyContinue
  }
  New-Item -ItemType Directory -Path (Join-Path $staging "data") | Out-Null
  Copy-Item -LiteralPath (Join-Path $projectDirectory "data\raw-reports-demo.json") -Destination (Join-Path $staging "data")
  $artifact = Join-Path $absoluteOutput ("wecom-finance-report-board-" + $package.version + ".zip")
  if (Test-Path -LiteralPath $artifact) { throw "Release artifact already exists. Verify it or choose another output directory: $artifact" }
  Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $artifact -CompressionLevel Optimal
  Write-Output $artifact
}
finally {
  if ((Resolve-Path -LiteralPath $staging).Path.StartsWith([System.IO.Path]::GetTempPath(), [System.StringComparison]::OrdinalIgnoreCase)) { Remove-Item -Recurse -Force -LiteralPath $staging }
}
