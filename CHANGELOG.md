# Changelog

## 0.2.0
- Import Anki .apkg / .colpkg (old and new formats, pictures, sounds, optional progress), also inside Electron.
- Study with spaced repetition, progress page (streak, 30 days, per deck), daily limits.
- .studyupdate files: checked install from a local file, safe fallback, go back to built-in. tools/make-update.js builds them.
- Tests: real Anki files, update checks, and a window test (npm run test:ui).

## 0.1.0
- First stage: Electron window, RUN / BUILD-APP / UNINSTALL scripts for Windows, Linux and Mac, automatic Node.js 24 download (ENSURE-NODE), GitHub update check, plugin loader with an example plugin.
