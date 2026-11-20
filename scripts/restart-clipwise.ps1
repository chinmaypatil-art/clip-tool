# Restarts Clipwise after a new build: stops the server on port 3000 and
# starts the "Clipwise" boot task again. The server runs in the task's own
# session, so stopping it needs an administrator window; this script asks
# for one itself.
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Start-Process powershell -Verb RunAs -ArgumentList "-ExecutionPolicy Bypass -File `"$PSCommandPath`""
  exit
}

Stop-ScheduledTask -TaskName Clipwise -ErrorAction SilentlyContinue
$server = (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue).OwningProcess | Select-Object -First 1
if ($server) { Stop-Process -Id $server -Force }
Start-Sleep -Seconds 2
Start-ScheduledTask -TaskName Clipwise
Write-Host "Clipwise restarted."
Start-Sleep -Seconds 3
