@echo off
setlocal
title StudyDeck
cd /d "%~dp0"

call "%~dp0ENSURE-NODE.bat"
if errorlevel 1 (
  echo.
  echo Node.js is needed to continue. Install Node.js 24 LTS or newer from
  echo https://nodejs.org ^(the LTS button^) and run this again.
  pause
  exit /b 1
)

if not exist "node_modules\electron" (
  echo First run: downloading the libraries ^(a few minutes, internet needed^).
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo The download did not finish. Check your internet connection and double-click RUN.bat to try again.
    pause
    exit /b 1
  )
)
call npm start
endlocal
