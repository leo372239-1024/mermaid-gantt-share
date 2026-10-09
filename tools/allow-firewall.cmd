@echo off
REM ============================================================
REM  Allow inbound TCP 18080 so phones / tablets on the same LAN
REM  can reach the local gantt service.
REM
REM  Run this ONCE, as Administrator:
REM      right-click -> "Run as administrator"
REM
REM  Remove the rule later with:
REM      netsh advfirewall firewall delete rule name="MermaidGanttShare 18080"
REM ============================================================
setlocal

net session >nul 2>&1
if %errorlevel% NEQ 0 (
  echo [gantt] Administrator privileges are required.
  echo [gantt] Right-click this file and choose "Run as administrator".
  pause
  exit /b 1
)

set "RULENAME=MermaidGanttShare 18080"

netsh advfirewall firewall delete rule name="%RULENAME%" >nul 2>&1
netsh advfirewall firewall add rule name="%RULENAME%" dir=in action=allow protocol=TCP localport=18080 profile=private,domain

if %errorlevel% NEQ 0 (
  echo [gantt] Failed to add the firewall rule.
  pause
  exit /b 1
)

echo.
echo [gantt] Firewall rule added: %RULENAME%  (inbound TCP 18080)
echo [gantt] LAN devices can now open  http://^<this-pc-ip^>:18080
echo.
pause
endlocal
