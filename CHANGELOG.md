# Changelog

## 0.7.0
- Make decks and cards: "New deck…", "Rename", and a "Cards" screen per deck to add (Basic, Basic and reversed, Cloze), edit, search, move and delete cards.
- Cards and edits made in StudyDeck stay in StudyDeck: they are not sent to AnkiWeb, and a sync never overwrites or removes them.
- If your decks are syncing with AnkiWeb, StudyDeck says so and asks before installing an update, restarting or closing: install now, or wait until the sync has finished (it then installs / restarts / closes by itself).

## 0.6.0
- Updates from GitHub: StudyDeck checks the Updates folder of Grid21/StudyDeck, tells you when a newer version exists, downloads and installs it on one click, then offers a restart. Settings: check at start-up, and restart automatically after an update.
- PUBLISH-UPDATE.sh / .bat: builds the update file and pushes it (with the source) to GitHub in one step.

## 0.5.1
- AnkiWeb sync: identifies itself in the way Anki does, because AnkiWeb answered "400" to the previous text.

## 0.5.0
- Fixed the "405 Not Allowed" error when signing in to AnkiWeb (AnkiWeb redirects to your account's server; StudyDeck now follows that correctly).
- AnkiWeb sync now works both ways: studied cards and review history are sent back. A backup of your AnkiWeb collection is saved first.
- Audio plays automatically at the start of each side of a card and when the answer is shown (R replays).
- Tests: two-way sync against Anki's official server (push-test).

## 0.4.0
- AnkiWeb sync (download): sign in on the Decks screen and pull your decks, pictures and sounds from Anki's own servers. No server of your own needed. One way for now.
- Discord sign-in on the friends server, an opt-in "Let people find me through Discord", "People you may know" (shared Discord servers) and adding by Discord name.
- Tests: sync against Anki's official sync server (sync-test, and inside the real window), Discord against a pretend Discord.

## 0.3.1
- Fixed: sounds and pictures from decks did not load (the media address "sd-media://1/..." was read as an IP address). Files are now served with the right type and seeking support.
- Sounds now play automatically when a card or its answer appears, like Anki (first sound of the side; the question's sound is not repeated on the answer).
- Tests: a real sound file is loaded and seeked inside the window; files outside the media folder are refused.

## 0.3.0
- Friends: accounts, friend codes, requests, per-subject sharing (daily totals only), friends list, "Study together" comparison.
- Open source friends server in server/ (no outside libraries), with RUN-SERVER scripts. Passwords hashed, rate limits, https required off-network.
- Tests: friends server + client (npm test), and the real window talking to a real server (npm run test:ui).

## 0.2.0
- Import Anki .apkg / .colpkg (old and new formats, pictures, sounds, optional progress), also inside Electron.
- Study with spaced repetition, progress page (streak, 30 days, per deck), daily limits.
- .studyupdate files: checked install from a local file, safe fallback, go back to built-in. tools/make-update.js builds them.
- Tests: real Anki files, update checks, and a window test (npm run test:ui).

## 0.1.0
- First stage: Electron window, RUN / BUILD-APP / UNINSTALL scripts for Windows, Linux and Mac, automatic Node.js 24 download (ENSURE-NODE), GitHub update check, plugin loader with an example plugin.
