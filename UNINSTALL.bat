@echo off
rem StudyDeck - uninstall (Windows)
rem
rem  - Installed it with StudyDeck-Setup.exe?  This starts that program's own uninstaller, which asks whether to
rem    delete your data as well.
rem  - Ran it from the folder?  This removes the parts StudyDeck made, asking before each one.
rem Your data (decks, notes, friends, plugins, settings) is always asked separately and the answer is "no"
rem unless you choose Y. This file never deletes the source folder it sits in.
setlocal EnableExtensions
cd /d "%~dp0"

echo =============================================================
echo   StudyDeck - uninstall
echo =============================================================
echo.

rem a running StudyDeck keeps its files in use
tasklist /fi "imagename eq StudyDeck.exe" 2>nul | find /i "StudyDeck.exe" >nul
if not errorlevel 1 (
  echo StudyDeck is running. It needs to be closed first.
  choice /c YN /n /m "Close it now? [Y/N] "
  if errorlevel 2 (
    echo Okay. Close StudyDeck yourself and run this again.
    goto :end
  )
  taskkill /im "StudyDeck.exe" /f >nul 2>nul
  timeout /t 2 /nobreak >nul
)

rem ---- 1. installed with the installer? ----
set "UNINST="
if exist "%LocalAppData%\Programs\StudyDeck\Uninstall StudyDeck.exe" set "UNINST=%LocalAppData%\Programs\StudyDeck\Uninstall StudyDeck.exe"
if not defined UNINST (
  for /f "usebackq delims=" %%u in (`powershell -NoProfile -Command "$k=Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq 'StudyDeck' } | Select-Object -First 1; if ($k -and $k.UninstallString) { [regex]::Match($k.UninstallString,'^.*?\.exe').Value.Trim([char]34) }" 2^>nul`) do set "UNINST=%%u"
)
if defined UNINST if not exist "%UNINST%" set "UNINST="

set "REMOVED=0"
set "KEPT=0"

if defined UNINST (
  echo StudyDeck is installed on this computer:
  echo     %UNINST%
  echo.
  echo Its uninstaller will open. It asks at the end whether to delete your data too.
  choice /c YN /n /m "Start the uninstaller now? [Y/N] "
  if errorlevel 2 (
    echo Okay, the installed program was kept.
    set /a KEPT+=1
  ) else (
    start "" "%UNINST%"
    echo.
    echo Finish the uninstaller window that just opened, then come back here and press any key.
    pause >nul
    set /a REMOVED+=1
  )
  echo.
)

rem ---- 2. parts made next to this file ----
if exist "%~dp0StudyDeck\" (
  echo The finished program folder made by BUILD-APP:
  echo     %~dp0StudyDeck
  choice /c YN /n /m "    Remove it? [Y/N] "
  if errorlevel 2 ( echo     kept. & set /a KEPT+=1 ) else ( rmdir /s /q "%~dp0StudyDeck" & echo     removed. & set /a REMOVED+=1 )
  echo.
)
if exist "%~dp0node_modules\" (
  echo The libraries StudyDeck downloaded on its first run:
  echo     %~dp0node_modules
  choice /c YN /n /m "    Remove them? [Y/N] "
  if errorlevel 2 ( echo     kept. & set /a KEPT+=1 ) else ( rmdir /s /q "%~dp0node_modules" & echo     removed. & set /a REMOVED+=1 )
  echo.
)

rem ---- 3. the Node.js copy StudyDeck's scripts downloaded for themselves ----
if "%STUDYDECK_NODE_DIR%"=="" set "STUDYDECK_NODE_DIR=%LocalAppData%\studydeck-node"
if exist "%STUDYDECK_NODE_DIR%\node.exe" (
  echo The copy of Node.js that StudyDeck's scripts downloaded for themselves
  echo ^(a Node.js you installed yourself is never touched^):
  echo     %STUDYDECK_NODE_DIR%
  choice /c YN /n /m "    Remove it? [Y/N] "
  if errorlevel 2 ( echo     kept. & set /a KEPT+=1 ) else ( rmdir /s /q "%STUDYDECK_NODE_DIR%" & echo     removed. & set /a REMOVED+=1 )
  echo.
)

rem ---- 4. your data (only if it is still there: the installer's uninstaller may already have asked) ----
if exist "%AppData%\studydeck\" (
  echo YOUR DATA: decks, notes, friends, plugins and settings.
  echo     %AppData%\studydeck
  echo     Keep this if you might install StudyDeck again. Removing it cannot be undone.
  choice /c YN /d N /t 60 /n /m "    Delete your data too? [Y/N, default N] "
  if errorlevel 2 ( echo     kept. & set /a KEPT+=1 ) else ( rmdir /s /q "%AppData%\studydeck" & echo     removed. & set /a REMOVED+=1 )
  echo.
)

echo =============================================================
echo   Finished: %REMOVED% removed, %KEPT% kept.
echo =============================================================
echo.
echo This source folder was not deleted. If you no longer want it, delete this folder yourself:
echo     %~dp0

:end
echo.
pause
endlocal
exit /b 0
