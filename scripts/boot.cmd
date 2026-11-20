@echo off
rem Entry point for the "Clipwise" boot task: starts a fresh log (keeping the
rem previous one as clipwise.old.log, so the log can't grow without limit),
rem then runs start-shared.cmd with its output in the log.
cd /d "%~dp0.."
if not exist storage\logs mkdir storage\logs
if exist storage\logs\clipwise.log move /y storage\logs\clipwise.log storage\logs\clipwise.old.log > nul
call scripts\start-shared.cmd >> storage\logs\clipwise.log 2>&1
