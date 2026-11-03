@echo off
setlocal
cd /d "%~dp0"
if "%~1"=="" (
    echo Launching Wokwi Offline Suite Setup ^& RC Car TOML Generator GUI...
    WokwiOfflineSetup.exe --gui
) else (
    WokwiOfflineSetup.exe %*
)
