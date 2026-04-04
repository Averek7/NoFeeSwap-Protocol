$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$stateDir = Join-Path $root ".local"
$pidFile = Join-Path $stateDir "hardhat-node.pid"
$logFile = Join-Path $stateDir "hardhat-node.log"
$errFile = Join-Path $stateDir "hardhat-node.err.log"
$cmd = Join-Path $root "node_modules\.bin\hardhat.cmd"

New-Item -ItemType Directory -Force -Path $stateDir | Out-Null

if (Test-Path $pidFile) {
  $existingPid = Get-Content $pidFile | Select-Object -First 1
  if ($existingPid) {
    $process = Get-Process -Id $existingPid -ErrorAction SilentlyContinue
    if ($process) {
      Write-Output "Hardhat node already running with PID $existingPid"
      exit 0
    }
  }
}

$process = Start-Process -FilePath $cmd -ArgumentList "node" -WorkingDirectory $root -RedirectStandardOutput $logFile -RedirectStandardError $errFile -PassThru
$process.Id | Set-Content $pidFile
Write-Output "Started Hardhat node with PID $($process.Id)"
Write-Output "Log: $logFile"
