@echo off
set "WBRELAY_NO_PAUSE="
if /i "%~1"=="--no-pause" set "WBRELAY_NO_PAUSE=1"
rem =====================================================================
rem  mitm-on.cmd - Run AS ADMINISTRATOR.
rem  Adds the hosts entry that routes copilot.tencent.com to the local
rem  TLS capture proxy (127.0.0.1:443). Idempotent.
rem  Certificates: generated here first if missing/stale (device-specific
rem  material, never committed) so a fresh clone needs no manual openssl.
rem =====================================================================
set "NODE="
for /f "delims=" %%i in ('where node 2^>nul') do (if not defined NODE set "NODE=%%i")
if not defined NODE (
  for /f "delims=" %%i in ('dir /b /ad-h /o-n "%USERPROFILE%\.workbuddy\binaries\node\versions" 2^>nul') do (
    if not defined NODE if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\%%i\node.exe" set "NODE=%USERPROFILE%\.workbuddy\binaries\node\versions\%%i\node.exe"
  )
)
if defined NODE (
  "%NODE%" "%~dp0certgen.cjs"
  if errorlevel 1 echo [WARN] certificate step failed - run: node "%~dp0certgen.cjs" --force
) else (
  echo [WARN] node.exe not found - the capture proxy cannot start without certificates.
)
findstr /C:"127.0.0.1 copilot.tencent.com" C:\Windows\System32\drivers\etc\hosts >nul 2>&1
if not errorlevel 1 (
  echo hosts entry already present.
  goto done
)
echo.>>C:\Windows\System32\drivers\etc\hosts
echo 127.0.0.1 copilot.tencent.com>>C:\Windows\System32\drivers\etc\hosts
findstr /C:"127.0.0.1 copilot.tencent.com" C:\Windows\System32\drivers\etc\hosts >nul 2>&1
if errorlevel 1 (
  echo [FAIL] could not write hosts - run this from an ADMINISTRATOR cmd.
  if not defined WBRELAY_NO_PAUSE pause
  exit /b 1
)
:done
echo [OK] copilot.tencent.com -^> 127.0.0.1 ^(token capture active^).
echo      Keep the 443 capture proxy running: dsh-channel.cmd starts it automatically.
if not defined WBRELAY_NO_PAUSE pause
exit /b 0
