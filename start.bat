@echo off
cd /d "%~dp0"
if exist "%~dp0node.exe" (
  set "NODE=%~dp0node.exe"
) else (
  set "NODE=node"
)
start "" cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:3000"
%NODE% server.js
pause