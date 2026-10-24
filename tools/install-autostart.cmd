@echo off
REM ============================================================
REM  Install the logon auto-start entry for the local stack.
REM
REM  Primary : scheduled task "MermaidGanttShare-Local"
REM            (cmd.exe -> tools\local-up.cmd; no Windows Script Host,
REM             no Startup folder -- see tools\register-autostart.ps1)
REM  Fallback: MermaidGanttAutoStart.vbs copied into the per-user
REM            Startup folder. Harmless redundancy; some HIPS products
REM            block script autostart from the Startup folder, so this
REM            layer alone is not trustworthy.
REM
REM  No admin rights required.
REM ============================================================
setlocal
set "SRC=%~dp0MermaidGanttAutoStart.vbs"
set "DST=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\MermaidGanttAutoStart.vbs"

echo [gantt] Registering scheduled task (primary)...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0register-autostart.ps1"
if errorlevel 1 (
  echo [gantt] WARNING: scheduled task registration failed - see message above.
  echo [gantt]          The Startup-folder fallback below is the only layer left.
)

if not exist "%SRC%" (
  echo [gantt] Fallback source not found: %SRC%
  endlocal
  exit /b 0
)

copy /Y "%SRC%" "%DST%" >nul
if errorlevel 1 (
  echo [gantt] Fallback copy failed -^> %DST%
) else (
  echo [gantt] Fallback installed: %DST%
)

echo [gantt] Done. Remove everything again with tools\uninstall-autostart.cmd
endlocal
