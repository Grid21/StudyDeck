# StudyDeck

An open source flashcard app (a better take on Anki-style decks) with friends, shared study progress and plugins.
Works on Windows, Linux and Mac. Licensed GPL-3.0-or-later.

## Install (Node.js 24 LTS or newer is needed, and the scripts get it for you)

You do not need to install Node.js yourself. If it is missing, the scripts download a private copy.

**Windows**
1. Double-click `RUN.bat` to start the program right away, or
2. Double-click `BUILD-APP.bat` to make `StudyDeck-Setup.exe` (an installer with an uninstaller).

**Linux**
1. Open a terminal in this folder. Run `chmod +x *.sh` once.
2. `./RUN.sh` starts the program, or `./BUILD-APP.sh` makes `StudyDeck/StudyDeck.AppImage`.
3. If the AppImage says "FUSE", run `sudo apt install libfuse2t64` (Ubuntu 24.04 / Mint 22) or `libfuse2` (older).

**Mac**
1. Open Terminal in this folder. Run `chmod +x *.sh` once.
2. `./RUN.sh` starts the program, or `./BUILD-APP.sh` makes a `.dmg`. Mac builds must be made on a Mac.

## Uninstall
Double-click `UNINSTALL.bat` (Windows) or run `./UNINSTALL.sh` (Linux / Mac). It shows each part it found and asks
before removing it. Your data (decks, notes, friends, plugins, settings) is asked about separately and is kept unless you say yes.
The source folder itself is never deleted.

## Importing decks
Decks > "Import deck..." (or drag `.apkg` / `.colpkg` files into the window). Old and new Anki file formats work, with
pictures and sounds. "Keep my progress from Anki" brings over your intervals. Importing the same deck again updates it
and keeps your progress here.

## Studying and progress
Study any deck (or all decks) with Again / Hard / Good / Easy. Keys: Space or Enter shows the answer, 1-4 rate, Esc leaves.
Progress shows today, your streak, 30 days of reviews and your cards by deck. Daily limits are in Settings.
Cards never run scripts, because deck files are untrusted.

## Updates (from a local file for now)
Settings > "Install update from file..." and choose a `.studyupdate` file. It is checked (checksums, allowed file types)
before anything is installed, and used after a restart. "Use the built-in version again" goes back. If an update fails to
start, StudyDeck returns to the built-in version by itself. Your decks and progress are never touched by updates.
A `.studyupdate` carries code files only. `.bat` / `.sh` scripts, `main.js` and new libraries come in the source zip.
Developers: `node tools/make-update.js --notes "What changed" --out <folder>` builds one.
The GitHub update check (`updates:checkOnline`) is written but not shown yet; set your GitHub address in `package.json` first.

## Plugins
Plugins are folders in your data folder's `plugins` directory (Plugins page > "Open plugins folder"). Each needs a
`plugin.json` and a JavaScript file; see the example copied there on first run. A plugin can do anything the app can,
so only install plugins you trust.

## What works now and what is next
Works: import, study, progress, plugins, local update files, install / uninstall on Windows, Linux and Mac.
Next, one stage at a time: adding and editing cards, browse and search, friends and shared progress (needs an online
service), importing from an online account, and the Anki add-on compatibility bridge (Anki add-ons are Python, so they
cannot run as they are). The `core/` folder has no Electron code, so it can be reused for iOS and Android.
