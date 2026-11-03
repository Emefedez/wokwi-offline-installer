@echo off
cd /d "%~dp0"
node "%USERPROFILE%\.wokwi\firmware-fallbacks\pio-fallback.js" run -e esp32-s3-wokwi %*
