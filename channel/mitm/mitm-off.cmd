@echo off
set "WBRELAY_NO_PAUSE="
if /i "%~1"=="--no-pause" set "WBRELAY_NO_PAUSE=1"
rem =====================================================================
rem  mitm-off.cmd - Run AS ADMINISTRATOR.
rem  Removes the hosts entry, restoring direct copilot.tencent.com access.
rem  --no-pause: unattended use (called by the plugin's /wbrelay delete).
rem =====================================================================
powershell -NoProfile -Command "$f='C:\Windows\System32\drivers\etc\hosts';$l=Get-Content $f | Where-Object {$_ -notmatch 'copilot\.tencent\.com'};Set-Content -Path $f -Value $l -Encoding ASCII"
findstr /C:"copilot.tencent.com" C:\Windows\System32\drivers\etc\hosts >nul 2>&1
if errorlevel 1 (
  echo [OK] hosts entry removed. Direct routing restored.
  if not defined WBRELAY_NO_PAUSE pause
  exit /b 0
)
echo [FAIL] entry still present - run this from an ADMINISTRATOR cmd, or check manually.
if not defined WBRELAY_NO_PAUSE pause
exit /b 1
