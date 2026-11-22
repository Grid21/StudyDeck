@echo off
setlocal
title StudyDeck friends server
cd /d "%~dp0"
call "%~dp0ENSURE-NODE.bat"
if errorlevel 1 (
  echo Node.js 24 LTS or newer is needed. Install it from https://nodejs.org and run this again.
  pause
  exit /b 1
)
echo Starting the friends server. Leave this window open. Press Ctrl+C to stop it.
node server\server.js
pause
endlocal
