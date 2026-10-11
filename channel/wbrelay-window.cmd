@echo off
title wbrelay-channel
cd /d "%~dp0"
rem resolve node then run the orchestrator (all logic in node, no cmd logic)
set "NODE="
for /f "delims=" %%i in ('where node 2^>nul') do (if not defined NODE set "NODE=%%i")
if not defined NODE (
  for /f "delims=" %%i in ('dir /b /ad-h /o-n "%USERPROFILE%\.workbuddy\binaries\node\versions" 2^>nul') do (
    if not defined NODE if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\%%i\node.exe" set "NODE=%USERPROFILE%\.workbuddy\binaries\node\versions\%%i\node.exe"
  )
)
if not defined NODE (
  echo [FAIL] node.exe not found. Install Node.js LTS first.
  pause
  exit /b 1
)
"%NODE%" "%~dp0orchestrator.cjs"
pause
