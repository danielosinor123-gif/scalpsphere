# Starts the API as a detached, untracked process on Windows.
#
# This is the local equivalent of running it under a supervisor: the process is
# NOT a child of any shell, so it survives the shell that launched it.
#
#   powershell -ExecutionPolicy Bypass -File scripts\start-dev.ps1
#
# Logs go to logs\dev-server.log. Stop it with scripts\stop-dev.ps1.
#
# For a *service* that also starts at boot, see docs/SETUP.md, "Keeping the API
# running on Windows" (NSSM). Production on a Linux VPS uses systemd instead:
# docs/DEPLOYMENT_HOSTINGER.md section 3.6.

$ErrorActionPreference = 'Stop'

$backend = Split-Path -Parent $PSScriptRoot
$logDir  = Join-Path $backend 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$logFile = Join-Path $logDir 'dev-server.log'

$existing = Get-NetTCPConnection -LocalPort 4000 -State Listen -ErrorAction SilentlyContinue |
  Select-Object -First 1
if ($existing) {
  Write-Output "Something is already listening on port 4000 (PID $($existing.OwningProcess))."
  Write-Output 'Stop it first with:  powershell -File scripts\stop-dev.ps1'
  exit 1
}

$node = (Get-Command node).Source
$proc = Start-Process -FilePath $node `
  -ArgumentList 'src/server.js' `
  -WorkingDirectory $backend `
  -WindowStyle Hidden `
  -RedirectStandardOutput $logFile `
  -RedirectStandardError "$logFile.err" `
  -PassThru

Write-Output ("started detached, PID " + $proc.Id)
Write-Output ("log: " + $logFile)

# Wait for the health endpoint, then confirm.
$up = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Milliseconds 500
  try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:4000/api/v1/health' `
      -UseBasicParsing -TimeoutSec 2
    if ($r.StatusCode -eq 200) { $up = $true; break }
  } catch { }
}

if ($up) {
  Write-Output 'health check: 200 OK'
  Write-Output 'This process is NOT tracked by any tool and will not time out.'
  Write-Output 'Stop it with:  powershell -File scripts\stop-dev.ps1'
} else {
  Write-Output 'WARNING: health check did not succeed within 15s — check the log file.'
  exit 1
}
