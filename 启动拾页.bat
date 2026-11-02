@echo off
cd /d "%~dp0"
start "" http://localhost:3000
"%~dp0node.exe" server.js
pause
