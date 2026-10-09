@echo off
REM Stop the local stack. Data stays in the named volume (gantt-pgdata).
setlocal
cd /d "%~dp0.."
docker compose down
echo [gantt] Stopped. Data preserved in volume gantt-pgdata.
endlocal
