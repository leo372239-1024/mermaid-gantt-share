@echo off
REM Show the local stack status and the addresses to open.
setlocal
cd /d "%~dp0.."
docker compose ps
echo.
echo   Local : http://localhost:18080
echo   LAN   : http://%COMPUTERNAME%:18080
echo   Health: http://localhost:18080/api/health
echo.
echo   DB    : localhost:15432 (postgres/gantt)
endlocal
