@echo off
REM Install the logon auto-start entry: copy the VBS launcher into the
REM per-user Startup folder. No admin rights required.
setlocal
set "SRC=%~dp0MermaidGanttAutoStart.vbs"
set "DST=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\MermaidGanttAutoStart.vbs"

if not exist "%SRC%" (
  echo [gantt] Source not found: %SRC%
  exit /b 1
)

copy /Y "%SRC%" "%DST%" >nul
if %errorlevel% NEQ 0 (
  echo [gantt] Copy failed -^> %DST%
  exit /b 1
)

echo [gantt] Auto-start installed.
echo         %DST%
echo [gantt] At every logon it runs tools\local-up.cmd with a hidden window.
echo [gantt] Remove it again with tools\uninstall-autostart.cmd
endlocal
