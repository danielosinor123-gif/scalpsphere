# Stops the detached API started by scripts\start-dev.ps1.
#
#   powershell -ExecutionPolicy Bypass -File scripts\stop-dev.ps1
#
# NOTE: this is a hard kill. On Windows the OS does not deliver SIGTERM to
# console processes, so the graceful pool-drain path in src/server.js cannot be
# triggered from here. Graceful shutdown is a production behaviour and is
# exercised by systemd on the Linux target (docs/DEPLOYMENT_HOSTINGER.md 3.6).

$ErrorActionPreference = 'Stop'

# Do NOT name this variable $pid: $PID is a read-only automatic variable holding
# this PowerShell process's own ID, and assigning to it silently fails under a
# suppressing ErrorActionPreference. That bug shipped once; do not reintroduce it.
$conn = Get-NetTCPConnection -LocalPort 4000 -State Listen -ErrorAction SilentlyContinue |
  Select-Object -First 1

if (-not $conn) {
  Write-Output 'Nothing is listening on port 4000.'
  exit 0
}

$targetPid = $conn.OwningProcess
$proc = Get-Process -Id $targetPid

if ($proc.ProcessName -ne 'node') {
  Write-Output ("PID $targetPid on port 4000 is $($proc.ProcessName), not node - not touching it.")
  exit 1
}

Write-Output "stopping node PID $targetPid"
Stop-Process -Id $targetPid -Force
Start-Sleep -Milliseconds 500

$still = Get-NetTCPConnection -LocalPort 4000 -State Listen -ErrorAction SilentlyContinue
if ($still) {
  Write-Output 'WARNING: port 4000 is still listening.'
  exit 1
}
Write-Output 'stopped.'
