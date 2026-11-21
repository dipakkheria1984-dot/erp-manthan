@echo off
REM Registers the monthly backup. Run once, from this folder.
REM Remove later with:  schtasks /Delete /TN "Manthan ERP Backup" /F
REM
REM The task runs WEEKLY, every Monday at 02:00, but backup.mjs is given
REM --if-due so it does nothing when the current month already has a verified
REM backup. A monthly trigger would simply be missed if the PC happened to be
REM switched off that night; this way the month's backup is taken on the first
REM Monday the PC is actually on.
schtasks /Create /TN "Manthan ERP Backup" /TR "\"%~dp0backup-task.cmd\"" /SC WEEKLY /D MON /ST 02:00 /RL LIMITED /F
echo.
echo Installed. Taking the first backup now...
echo.
cd /d "%~dp0"
node backup.mjs
echo.
pause
