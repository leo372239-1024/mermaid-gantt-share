@echo off
REM Remove the logon auto-start entry. The running stack is left untouched.
setlocal
set "DST=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\MermaidGanttAutoStart.vbs"

if exist "%DST%" (
  del /f /q "%DST%"
  echo [gantt] Auto-start removed: %DST%
) else (
  echo [gantt] Nothing to remove - auto-start was not installed.
)
endlocal
