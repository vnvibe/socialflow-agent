# hot-reload.ps1 - Reload agent code WITHOUT npm run build.
#
# WHY IT WORKS: package.json build.asarUnpack ships jobs/ lib/ browser/
# agent.js node_modules/ ms-playwright/ as REAL FILES under
# dist/win-unpacked/resources/app.asar.unpacked/. The agent child runs via
# fork(app.asar.unpacked/agent.js). So we only need to:
#   1) copy edited .js into app.asar.unpacked (jobs/lib/browser/agent.js)
#   2) kill ONLY the agent child process (CommandLine contains agent.js)
#   3) Electron main auto-respawns it in ~2s -> loads new code (fresh process,
#      clean require cache).
# Does NOT touch the Electron shell or the watchdog (watchdog only checks the
# .exe is alive).
#
# ONLY for .js edits in jobs/ lib/ browser/ agent.js. If you edit electron/
# (main.js, index.html - packed INSIDE the compressed asar) you MUST npm run build.
#
# Usage:  powershell -File scripts\hot-reload.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$unpacked = Join-Path $root 'dist\win-unpacked\resources\app.asar.unpacked'
if (-not (Test-Path $unpacked)) { Write-Error "app.asar.unpacked not found - need a full build first."; exit 1 }

# 1) Sync JS dirs (small, fast). Do NOT copy node_modules/ms-playwright.
$changed = 0
foreach ($item in @('jobs', 'lib', 'browser', 'agent.js')) {
  $src = Join-Path $root $item
  $dst = Join-Path $unpacked $item
  if (-not (Test-Path $src)) { continue }
  if (Test-Path $src -PathType Container) {
    $files = Get-ChildItem $src -Recurse -Filter *.js
    foreach ($f in $files) {
      $rel = $f.FullName.Substring($src.Length)
      $target = (Join-Path $dst $rel)
      $need = $true
      if (Test-Path $target) {
        $need = (Get-FileHash $f.FullName).Hash -ne (Get-FileHash $target).Hash
      }
      if ($need) {
        $tdir = Split-Path $target -Parent
        if (-not (Test-Path $tdir)) { New-Item -ItemType Directory -Force -Path $tdir | Out-Null }
        Copy-Item $f.FullName $target -Force
        Write-Output "  ~ $item$rel"
        $changed++
      }
    }
  } else {
    $target = Join-Path $unpacked $item
    if (-not (Test-Path $target) -or ((Get-FileHash $src).Hash -ne (Get-FileHash $target).Hash)) {
      Copy-Item $src $target -Force; Write-Output "  ~ $item"; $changed++
    }
  }
}
Write-Output "Synced $changed .js file(s) into bundle."

# 2) Kill ONLY the agent child (process whose command line contains agent.js)
$agent = Get-CimInstance Win32_Process -Filter "Name='SocialFlow Agent.exe'" |
  Where-Object { $_.CommandLine -match 'agent\.js' }
if (-not $agent) { Write-Output "No agent child running - Electron will start it when the app opens."; exit 0 }
foreach ($a in $agent) { Stop-Process -Id $a.ProcessId -Force; Write-Output "Killed agent child PID $($a.ProcessId)" }

# 3) Wait for Electron main to respawn (2s * attempt, up to ~10s)
Start-Sleep -Seconds 4
$new = Get-CimInstance Win32_Process -Filter "Name='SocialFlow Agent.exe'" |
  Where-Object { $_.CommandLine -match 'agent\.js' }
if ($new) { Write-Output "New agent child up: PID $($new.ProcessId) - new code loaded." }
else { Write-Output "Agent child not back yet (Electron respawns in ~2-6s), check again shortly." }
