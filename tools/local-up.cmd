@echo off
REM ============================================================
REM  Mermaid Gantt Share - local service launcher (idempotent)
REM
REM  Waits for the Docker engine to become ready, then brings the
REM  stack up. Safe to run repeatedly.
REM
REM  Invoked by:
REM    1) scheduled task "MermaidGanttShare-Local"  (primary)
REM       -- register with tools\register-autostart.ps1
REM    2) Startup-folder MermaidGanttAutoStart.vbs  (legacy fallback)
REM
REM  NOTE: this file is intentionally ASCII-only. cmd.exe reads
REM  .cmd files using the active OEM code page, so non-ASCII text
REM  here would show up as mojibake on some machines.
REM
REM  Every run appends a trace to  <repo>\logs\autostart.log
REM  (gitignored). Read that file first when autostart misbehaves.
REM ============================================================
setlocal EnableExtensions
cd /d "%~dp0.."

set "ROOT=%CD%"
set "LOGDIR=%ROOT%\logs"
set "LOG=%LOGDIR%\autostart.log"

if not exist "%LOGDIR%" mkdir "%LOGDIR%" >nul 2>&1

call :log "==================== launcher start ===================="
call :log "root=%ROOT%"
REM NOTE: do NOT log %COMPUTERNAME% - this machine's name is non-ASCII and
REM would land in the log as mojibake (the log is written in the OEM code page).
call :log "user=%USERNAME%"

if not exist "%ROOT%\docker-compose.yml" (
  call :log "FATAL: docker-compose.yml not found under %ROOT%"
  call :log "       (drive not mounted yet, or wrong working directory)"
  goto :fail
)

REM ---- docker CLI must be resolvable -------------------------
where docker >nul 2>&1
if errorlevel 1 (
  call :log "FATAL: docker CLI not found on PATH"
  call :log "PATH=%PATH%"
  goto :fail
)
REM 'where' prints both "docker" and "docker.exe"; log only the first hit.
set "DOCKER_SHOWN="
for /f "delims=" %%i in ('where docker 2^>nul') do (
  if not defined DOCKER_SHOWN (
    call :log "docker CLI = %%i"
    set "DOCKER_SHOWN=1"
  )
)

REM ---- wait for the engine (up to 180 tries x ~6s = ~18 min) --
set /a tries=0
set /a maxTries=180

:waitdocker
docker info >nul 2>&1
if %errorlevel%==0 goto ready

set /a tries+=1
if %tries% GEQ %maxTries% (
  call :log "FATAL: Docker engine not ready after %maxTries% tries (~18 min) - giving up"
  call :log "       Is Docker Desktop running / is AutoStart enabled?"
  goto :fail
)

if %tries%==1   call :log "waiting for Docker engine ..."
if %tries%==12  call :log "  ... still waiting (~1 min)"
if %tries%==36  call :log "  ... still waiting (~3 min)"
if %tries%==72  call :log "  ... still waiting (~6 min)"
if %tries%==120 call :log "  ... still waiting (~10 min)"

REM Use ping as the delay: this script may be launched with a hidden
REM window and no stdin, and timeout.exe fails without stdin.
ping -n 6 127.0.0.1 >nul 2>&1
goto waitdocker

:ready
call :log "Docker engine ready after %tries% tries - running: docker compose up -d"

docker compose up -d >>"%LOG%" 2>&1
if errorlevel 1 (
  call :log "FATAL: docker compose up -d failed (exit %errorlevel%) - see output above"
  goto :fail
)

REM NOTE: never put a '>' in a :log message -- cmd would treat it as a
REM redirection operator and silently swallow the rest of the line.
call :log "OK: stack started (http://localhost:18080)"
call :log "===================== launcher end ====================="
endlocal
exit /b 0

:fail
call :log "===================== launcher end (FAILED) ============"
endlocal
exit /b 1

REM ---- append one timestamped line to the log ----------------
:log
echo [%DATE% %TIME%] %~1>>"%LOG%"
exit /b 0
