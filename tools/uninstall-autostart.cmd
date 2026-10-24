@echo off
REM ============================================================
REM  Remove the logon auto-start entries for the local stack.
REM  The running stack is left untouched - only the trigger goes away.
REM ============================================================
setlocal

echo [gantt] Removing scheduled task (primary)...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0unregister-autostart.ps1"

set "DST=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\MermaidGanttAutoStart.vbs"
if exist "%DST%" (
  del /f /q "%DST%"
  echo [gantt] Removed startup entry: %DST%
) else (
  echo [gantt] Startup entry was not present.
)

endlocal
