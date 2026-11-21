@echo off
REM What the scheduled task runs. Not meant to be double-clicked — use
REM run-backup.cmd for that. No `pause` here, so an unattended run exits.
cd /d "%~dp0"
node backup.mjs --if-due
