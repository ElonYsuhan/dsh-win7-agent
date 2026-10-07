@echo off
setlocal
cd /d "%~dp0\.."

echo [1/3] installing build dependencies
call npm install
if errorlevel 1 goto fail

echo [2/3] building portable Win7 x64 package
call npm run dist:win:portable
if errorlevel 1 goto fail

echo [3/3] done
echo Output directory: %CD%\release
dir /b "%CD%\release"
exit /b 0

:fail
echo Build failed.
exit /b 1
