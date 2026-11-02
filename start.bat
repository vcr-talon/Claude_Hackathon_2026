@echo off
rem コンクリート数量算出アプリを起動する（ブラウザが自動で開きます）
cd /d "%~dp0"
".venv\Scripts\python.exe" backend\server.py %*
pause
