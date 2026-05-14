$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$pluginDir = "D:\Workspace\NoteSpace\.obsidian\plugins\highlight-annotation"
$files = @(
  "main.js",
  "manifest.json",
  "styles.css",
  "versions.json"
)
$settingsFile = Join-Path $pluginDir "data.json"
$settingsBackup = $null

New-Item -ItemType Directory -Force -Path $pluginDir | Out-Null

if (Test-Path -LiteralPath $settingsFile) {
  $settingsBackup = Join-Path $env:TEMP ("highlight-annotation-data-" + [guid]::NewGuid().ToString() + ".json")
  Copy-Item -LiteralPath $settingsFile -Destination $settingsBackup -Force
}

foreach ($file in $files) {
  $source = Join-Path $repoRoot $file
  $target = Join-Path $pluginDir $file

  if (-not (Test-Path -LiteralPath $source)) {
    throw "Missing deployment file: $source"
  }

  Copy-Item -LiteralPath $source -Destination $target -Force
}

if ($settingsBackup) {
  Copy-Item -LiteralPath $settingsBackup -Destination $settingsFile -Force
  Remove-Item -LiteralPath $settingsBackup -Force
  Write-Host "Preserved existing plugin settings: $settingsFile"
}

Write-Host "Deployed highlight-annotation to $pluginDir"
