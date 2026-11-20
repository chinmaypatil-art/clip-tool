@echo off
rem Starts Clipwise for sharing and keeps it running:
rem   1. makes sure Ollama (Gemma) is up,
rem   2. publishes port 3000 with Tailscale Funnel,
rem   3. runs the production server, restarting it if it ever stops.
rem Runs at boot from the "Clipwise" scheduled task (no login needed), or by
rem double-click. Run "npm run build" first after pulling new code.
setlocal
cd /d "%~dp0.."
title Clipwise

rem Already running (e.g. started at boot)? Then there is nothing to do.
curl -s -o nul --max-time 3 http://127.0.0.1:3000/login
if not errorlevel 1 (
  echo Clipwise is already running.
  exit /b 0
)

curl -s -o nul --max-time 3 http://127.0.0.1:11434/api/version
if errorlevel 1 (
  echo Starting Ollama...
  rem Via Start-Process so Ollama doesn't inherit (and keep open) this
  rem script's log file, which would stop the next restart from logging.
  powershell -NoProfile -Command "$o = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'; if (-not (Test-Path $o)) { $o = 'ollama' }; Start-Process -WindowStyle Hidden -FilePath $o -ArgumentList serve"
)

rem YouTube changes often; a stale yt-dlp is the most common reason downloads break.
call npx tsx -e "import('./src/lib/binaries.ts').then(m=>require('child_process').spawnSync(m.getYtDlpPath(),['-U'],{stdio:'inherit'}))"

set "TAILSCALE=%ProgramFiles%\Tailscale\tailscale.exe"
if not exist "%TAILSCALE%" set "TAILSCALE=tailscale"
"%TAILSCALE%" funnel --bg 3000

:run
echo [%date% %time%] starting Clipwise
call npm start
echo [%date% %time%] Clipwise stopped; restarting in 5 seconds
timeout /t 5 /nobreak > nul
goto run
