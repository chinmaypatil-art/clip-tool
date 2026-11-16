@echo off
rem Starts Clipwise for sharing: production server on :3000, published by
rem Tailscale Funnel. Double-click it after a reboot; close the window to stop.
rem Run "npm run build" first after pulling new code.
cd /d "%~dp0.."
"C:\Program Files\Tailscale\tailscale.exe" funnel --bg 3000
npm start
