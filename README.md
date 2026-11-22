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

## Friends and shared progress
Friends > enter a friends server address, create an account, then add friends by their friend code (or username) and
tick which subjects you share. A subject is a top-level deck, such as "Korean". Friends see only daily review totals for
those subjects, plus your streak; never your cards or notes. When you and a friend share the same subject, "Study together"
compares the last 7 days. The server is open source in the `server` folder (`RUN-SERVER.bat` / `./RUN-SERVER.sh`, see
`server/README.md`). Someone has to host it with an https:// address for friends to join from the internet.

## Syncing with AnkiWeb (no server of your own)
Decks screen > "Sync with AnkiWeb": sign in with your AnkiWeb email and password. StudyDeck downloads your decks, pictures
and sounds straight from Anki's own servers (it keeps only the sign-in key AnkiWeb gives back, never your password).
"Sync now" fetches only what changed; "Re-download everything" starts over. Your StudyDeck progress on cards you already
have is kept, and new cards bring their Anki progress.
It works BOTH WAYS: cards you study in StudyDeck (with their review history) are sent to AnkiWeb, so Anki on your phone sees them.
Before anything is sent, a copy of your AnkiWeb collection is saved in StudyDeck's data folder ("anki-backups", last 3 kept).
Limits: card/note editing and new cards made in StudyDeck are not sent yet, and Anki's FSRS memory data is not updated on upload. It follows Anki's sync protocol,
which Anki does not promise to keep stable, and it was tested against Anki's own sync server, not against the live AnkiWeb.
If AnkiWeb refuses it, the screen shows the message. "Advanced" lets you use any other Anki sync server.

## Discord sign-in and "people you may know" (optional)
If the friends server has Discord turned on, the Friends screen shows "Continue with Discord". You then switch on "Let
people find me through Discord". You and another person both need that on: then you see each other under "People you may
know" when you share a Discord server (only the number of shared servers is shown, never their names), and friends can add
you by your Discord name. StudyDeck cannot read your Discord friends list; Discord does not allow ordinary apps to do that.
Whoever runs the friends server creates a free Discord application (discord.com/developers) and sets `DISCORD_CLIENT_ID`,
`DISCORD_CLIENT_SECRET` and `DISCORD_REDIRECT_URI` (your server's address + `/discord/callback`, also added as a Redirect
in the Discord application). Tested with a pretend Discord, not the real one.

## Plugins
Plugins are folders in your data folder's `plugins` directory (Plugins page > "Open plugins folder"). Each needs a
`plugin.json` and a JavaScript file; see the example copied there on first run. A plugin can do anything the app can,
so only install plugins you trust.

## What works now and what is next
Works: import, study, progress, friends and shared progress, plugins, local update files, install / uninstall on Windows, Linux and Mac.
Next, one stage at a time: two-way AnkiWeb sync, adding and editing cards, browse and search, and the Anki add-on compatibility bridge (Anki add-ons are Python, so they
cannot run as they are). The `core/` folder has no Electron code, so it can be reused for iOS and Android.
