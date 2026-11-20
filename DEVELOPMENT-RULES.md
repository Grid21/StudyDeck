# Development rules

- Never silently remove a file that is supposed to be there (UNINSTALL / BUILD / RUN / ENSURE-NODE scripts, `build/installer.nsh`, docs, tests). If one is removed on purpose, list it in `tools/removed-files.txt` with the reason.
- After adding files run `node tools/check-release.js --update`. Before delivering run `node tools/check-release.js` and `npm test`.
- Keep `core/` free of Electron code so it can be reused on iOS and Android.
- Work in small stages. Keep CHANGELOG.md current. Patch version = fixes, minor version = features.
- README.md and FEATURES.md stay identical and start with the install steps and "Node.js 24 LTS or newer".
- Be honest about testing: Windows scripts, the Windows installer and Mac builds have not been run on real machines unless stated.
- **Respect the owner's limited chat usage.** Keep replies short, avoid re-reading files and long outputs, do the most per session, and apply this to .studyupdate work too.
- Updates travel as `.studyupdate` (code files only); scripts and new libraries travel in the source zip, and the reply says so.
