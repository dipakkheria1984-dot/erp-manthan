@echo off
REM Re-reads every archive in the backup folder and checks it is complete and
REM unchanged. Worth running by hand once in a while: an archive nobody has
REM ever read back is an assumption, not a backup.
cd /d "%~dp0"
node backup.mjs --verify-only
echo.
pause
