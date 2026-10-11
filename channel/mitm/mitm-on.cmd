@echo off
set "WBRELAY_NO_PAUSE="
if /i "%~1"=="--no-pause" set "WBRELAY_NO_PAUSE=1"
rem =====================================================================
rem  mitm-on.cmd - Run AS ADMINISTRATOR.
rem  Adds the hosts entry that routes copilot.tencent.com to the local
rem  TLS capture proxy (127.0.0.1:443). Idempotent.
rem =====================================================================
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
