@echo off
setlocal
cd /d "%~dp0"

set "AGENT_HOME=%~dp0data"
set "HOST=0.0.0.0"
set "PORT=8080"
set "ELECTRON_RUN_AS_NODE=1"

echo Starting DSH Win7 Agent Service
echo URL:  http://%HOST%:%PORT%
echo Data: %AGENT_HOME%
echo.
echo Keep this window open while the service is running.
echo.

"%~dp0DSH-Win7-Service.exe" "%~dp0resources\app\server\index.js"
exit /b %errorlevel%
