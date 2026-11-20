# Registers the "Clipwise" scheduled task: starts the app at boot, before
# anyone logs in, as the user who runs this script. Needs an administrator
# window; run it once:
#   Start-Process powershell -Verb RunAs -ArgumentList '-ExecutionPolicy Bypass -NoExit -File "<path>\install-boot-task.ps1"'
param([string]$User = "$env:COMPUTERNAME\$env:USERNAME")

$root = Split-Path -Parent $PSScriptRoot
$start = Join-Path $root 'scripts\start-shared.cmd'
$log = Join-Path $root 'storage\clipwise.log'

$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"`"$start`" >> `"$log`" 2>&1`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtStartup
$trigger.Delay = 'PT1M'
$principal = New-ScheduledTaskPrincipal -UserId $User -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName 'Clipwise' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force |
  Select-Object TaskName, State
Write-Host "Done: Clipwise now starts at boot as $User. You can close this window."
