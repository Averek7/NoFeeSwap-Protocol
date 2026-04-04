$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path (Join-Path $root ".local") "hardhat-node.pid"

if (-not (Test-Path $pidFile)) {
  Write-Output "No PID file found."
  exit 0
}

$hardhatPid = Get-Content $pidFile | Select-Object -First 1
if ($hardhatPid) {
  $process = Get-Process -Id $hardhatPid -ErrorAction SilentlyContinue
  if ($process) {
    Stop-Process -Id $hardhatPid
    Write-Output "Stopped Hardhat node with PID $hardhatPid"
  } else {
    Write-Output "PID file existed, but the process was not running."
  }
}

Remove-Item -LiteralPath $pidFile -Force
