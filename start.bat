@echo off
rem NOVA RP AI - start on Windows (double-click). Restarts the bot automatically if it stops.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [!] Node.js not found. Install Node.js 22 LTS or newer: https://nodejs.org
  pause
  exit /b 1
)

if not exist ".env" (
  echo [!] File .env not found. Copy .env.example to .env and fill DISCORD_TOKEN, DISCORD_CLIENT_ID, ENCRYPTION_KEY.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Installing packages...
  call npm install --no-audit --no-fund
)

:loop
echo Starting bot... (close this window or press Ctrl+C to stop)
node index.js
if errorlevel 3 if not errorlevel 4 (
  echo [!] Bot is already running in another window. Close it first.
  pause
  exit /b 3
)
echo.
echo Bot stopped. Restarting in 10 seconds... (Ctrl+C to cancel)
timeout /t 10 >nul
goto loop
