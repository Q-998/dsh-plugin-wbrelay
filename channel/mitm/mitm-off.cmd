@echo off
rem =====================================================================
rem  mitm-off.cmd - Run AS ADMINISTRATOR.
rem  Removes the hosts entry, restoring direct copilot.tencent.com access.
rem =====================================================================
powershell -NoProfile -Command "$f='C:\Windows\System32\drivers\etc\hosts';$l=Get-Content $f | Where-Object {$_ -notmatch 'copilot\.tencent\.com'};Set-Content -Path $f -Value $l -Encoding ASCII"
findstr /C:"copilot.tencent.com" C:\Windows\System32\drivers\etc\hosts >nul 2>&1
if errorlevel 1 (
  echo [OK] hosts entry removed. Direct routing restored.
) else (
  echo [FAIL] entry still present - check manually.
)
pause
