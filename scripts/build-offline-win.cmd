@echo off
setlocal
cd /d "%~dp0\.."

echo [1/3] installing build dependencies
call npm ci --offline
if errorlevel 1 goto fail

echo [2/3] building single-entry Win7 x64 package
call npm run build:desktop:win
if errorlevel 1 goto fail

echo [3/3] done
echo Output directory: %CD%\release\desktop\Agent-win-x64
dir /b "%CD%\release\desktop\Agent-win-x64"
exit /b 0

:fail
echo Build failed.
exit /b 1
