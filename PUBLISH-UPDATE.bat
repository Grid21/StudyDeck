@echo off
setlocal
cd /d "%~dp0"
echo =============================================================
echo   StudyDeck - publish an update to GitHub
echo =============================================================
echo.
if exist "%~dp0ENSURE-NODE.bat" (
  call "%~dp0ENSURE-NODE.bat"
  if errorlevel 1 exit /b 1
) else (
  where node >nul 2>nul || (echo Node.js was not found. Install it from https://nodejs.org & pause & exit /b 1)
)
where git >nul 2>nul || (echo Git was not found. Install it from https://git-scm.com & pause & exit /b 1)
if not exist ".git" (
  echo This folder is not connected to GitHub yet. Do this once:
  echo   1. git clone https://github.com/Grid21/StudyDeck.git
  echo   2. copy the StudyDeck program files into that new folder ^(replace when asked^)
  echo   3. run PUBLISH-UPDATE.bat from inside it
  pause & exit /b 1
)
for /f "delims=" %%v in ('node -p "require('./package.json').version"') do set VERSION=%%v
set "NOTES=%~1"
if "%NOTES%"=="" for /f "delims=" %%n in ('node -e "const t=require('fs').readFileSync('CHANGELOG.md','utf8').split(/\n## /)[1]||'';console.log(t.split('\n').slice(1).join(' ').trim().slice(0,400))"') do set "NOTES=%%n"
if not exist Updates mkdir Updates
echo Building update %VERSION% ...
node tools\make-update.js --notes "%NOTES%" --out Updates
if errorlevel 1 (echo Building the update failed. & pause & exit /b 1)
git add -A
git diff --cached --quiet && (echo Nothing new to send. Is the version number in package.json new? & pause & exit /b 0)
git commit -q -m "StudyDeck %VERSION%"
echo Sending to GitHub ^(it may ask you to sign in^) ...
git push
if errorlevel 1 (echo Sending failed. Check that you are signed in to GitHub, then run this again. & pause & exit /b 1)
echo.
echo Done. Version %VERSION% is on GitHub. Running copies of StudyDeck will offer it.
pause
