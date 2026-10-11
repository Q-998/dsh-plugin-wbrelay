@echo off
rem =====================================================================
rem  gen-certs.cmd - generate / refresh the device capture certificates.
rem  No administrator rights needed. Run this when:
rem    - first deploying the plugin (normally automatic on channel start),
rem    - the certificate expired or the host name list changed,
rem    - you moved/copied the plugin directory to another machine.
rem  Args are forwarded: gen-certs.cmd --force   /   --status   /   --json
rem =====================================================================
title wbrelay-gen-certs
cd /d "%~dp0"
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
"%NODE%" "%~dp0certgen.cjs" %*
echo.
pause
