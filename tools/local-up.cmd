@echo off
REM ============================================================
REM  Mermaid Gantt Share - local service launcher (idempotent)
REM
REM  Waits for the Docker engine to become ready, then brings the
REM  stack up. Safe to run repeatedly. Invoked by the scheduled
REM  task "MermaidGanttShare-Local" at logon.
REM
REM  NOTE: this file is intentionally ASCII-only. cmd.exe reads
REM  .cmd files using the active OEM code page, so non-ASCII text
REM  here would show up as mojibake on some machines.
REM ============================================================
setlocal
cd /d "%~dp0.."

set /a tries=0
:waitdocker
docker info >nul 2>&1
if %errorlevel%==0 goto ready
set /a tries+=1
if %tries% GEQ 36 (
  echo [gantt] Docker engine not ready after 180s - giving up.
  echo [gantt] Is Docker Desktop running?
  exit /b 1
)
REM 用 ping 代替 timeout 做等待：本脚本由 VBS 以隐藏窗口启动（无控制台、无 stdin），
REM 而 timeout.exe 在无 stdin 时会直接报 "Input redirection is not supported" 并失败。
ping -n 6 127.0.0.1 >nul 2>&1
goto waitdocker

:ready
echo [gantt] Docker is ready, starting the stack...
docker compose up -d
if %errorlevel% NEQ 0 (
  echo [gantt] docker compose up failed.
  exit /b 1
)
echo.
echo [gantt] Started. Open http://localhost:18080
endlocal
