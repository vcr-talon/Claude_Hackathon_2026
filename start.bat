@echo off
rem Start the concrete quantity app (the browser opens automatically)
cd /d "%~dp0"
".venv\Scripts\python.exe" backend\server.py %*
pause
