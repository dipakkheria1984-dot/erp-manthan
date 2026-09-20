@echo off
REM Starts the Manthan ERP -> Tally Prime bridge. Keep this window open,
REM or run install-task.cmd once to start it automatically at logon.
cd /d "%~dp0"
node bridge.mjs
