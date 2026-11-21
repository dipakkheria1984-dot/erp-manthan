@echo off
REM Takes a backup now, whether or not this month already has one.
REM Run install-task.cmd once to have this happen automatically every month.
cd /d "%~dp0"
node backup.mjs %*
echo.
if errorlevel 1 (
  echo *** THE BACKUP FAILED. Read the messages above and backup.log. ***
) else (
  echo Backup complete.
)
pause
