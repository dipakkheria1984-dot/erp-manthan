@echo off
REM Registers the bridge to start automatically whenever this user logs on.
REM Run once, from this folder. Remove later with:  schtasks /Delete /TN "Manthan Tally Bridge" /F
schtasks /Create /TN "Manthan Tally Bridge" /TR "\"%~dp0start-bridge.cmd\"" /SC ONLOGON /RL LIMITED /F
echo.
echo Installed. The bridge will start at your next logon. Starting it now...
start "" "%~dp0start-bridge.cmd"
