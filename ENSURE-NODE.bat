@echo off
rem StudyDeck - makes sure Node.js 24 or newer is available (Windows).
rem Use it like this:   call ENSURE-NODE.bat     (exit code 0 = ready, 1 = failed)
rem If a good Node.js is already installed it is used and nothing is downloaded.
rem Otherwise a private copy is downloaded from nodejs.org into
rem   %LocalAppData%\studydeck-node
rem It never touches a Node.js you installed yourself; UNINSTALL.bat can remove the private copy.
rem This file deliberately has no "setlocal", so the PATH change reaches the script that called it.

if "%STUDYDECK_NODE_DIR%"=="" set "STUDYDECK_NODE_DIR=%LocalAppData%\studydeck-node"
set "SD_OK="

rem 1. a Node.js that is already installed
where node >nul 2>nul
if not errorlevel 1 (
  for /f %%v in ('node -p "process.versions.node.split('.')[0]" 2^>nul') do (
    if %%v GEQ 24 set "SD_OK=1"
  )
)
if defined SD_OK exit /b 0

rem 2. our private copy from an earlier run
if exist "%STUDYDECK_NODE_DIR%\node.exe" (
  set "PATH=%STUDYDECK_NODE_DIR%;%PATH%"
  for /f %%v in ('node -p "process.versions.node.split('.')[0]" 2^>nul') do (
    if %%v GEQ 24 set "SD_OK=1"
  )
)
if defined SD_OK exit /b 0

rem 3. download it
echo Node.js 24 or newer was not found. Downloading it now (about 30 MB)...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\get-node.ps1" -Dest "%STUDYDECK_NODE_DIR%"
if errorlevel 1 exit /b 1
set "PATH=%STUDYDECK_NODE_DIR%;%PATH%"
where node >nul 2>nul
if errorlevel 1 exit /b 1
exit /b 0
