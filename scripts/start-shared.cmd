@echo off
rem Starts Clipwise for sharing and keeps it running:
rem   1. makes sure Ollama (Gemma) is up,
rem   2. publishes port 3000 with Tailscale Funnel,
rem   3. runs the production server, restarting it if it ever stops.
rem Double-click it after a reboot; close the window to stop the app.
rem Run "npm run build" first after pulling new code.
setlocal
cd /d "%~dp0.."
title Clipwise

curl -s -o nul --max-time 3 http://127.0.0.1:11434/api/version
if errorlevel 1 (
  echo Starting Ollama...
  if exist "%LOCALAPPDATA%\Programs\Ollama\ollama app.exe" (
    start "" "%LOCALAPPDATA%\Programs\Ollama\ollama app.exe"
  ) else (
    start "" /min ollama serve
  )
)

set "TAILSCALE=%ProgramFiles%\Tailscale\tailscale.exe"
if not exist "%TAILSCALE%" set "TAILSCALE=tailscale"
"%TAILSCALE%" funnel --bg 3000

:run
echo [%date% %time%] starting Clipwise
call npm start
echo [%date% %time%] Clipwise stopped; restarting in 5 seconds (close this window to stop)
timeout /t 5 /nobreak > nul
goto run
