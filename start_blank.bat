@echo off
rem Start the app with no IFC loaded (blank). Use the "open IFC" button on the screen to load a file.
rem For demos and recordings: hackathon_model.ifc in this folder is NOT loaded automatically.
cd /d "%~dp0"
".venv\Scripts\python.exe" backend\server.py "__blank__"
pause
