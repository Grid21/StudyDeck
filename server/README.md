# StudyDeck friends server

A small open source program that lets StudyDeck users add each other and compare progress. It stores accounts,
friendships and DAILY TOTALS for subjects each person chose to share. It never sees cards or notes.

**Run it on your own computer (for testing)**
- Windows: `RUN-SERVER.bat` (from the main folder).  Linux / Mac: `./RUN-SERVER.sh`.
- Then in StudyDeck > Friends, enter `http://localhost:8787`. Other computers on your home network can use
  `http://<this computer's address>:8787` after starting it with `HOST=0.0.0.0`.

**Run it for friends over the internet**
- Put it on any host that can run Node.js 24 and gives you an `https://` address (a small cloud server, a Raspberry Pi
  with a tunnel, etc.). StudyDeck refuses plain `http://` addresses except on your own network, because passwords
  would travel in the open.
- Settings (environment variables): `PORT` (default 8787), `HOST` (default 127.0.0.1), `DATA_DIR` (default `server/data`).
- Back up `DATA_DIR/friends.db`. Accounts can be deleted from the Friends screen's server API (`/api/account/delete`).

**Discord sign-in (optional)**
1. Create an application at https://discord.com/developers/applications and copy its Client ID and Client Secret.
2. In its OAuth2 page add the Redirect `https://YOUR-SERVER/discord/callback` (for tests: `http://localhost:8787/discord/callback`).
3. Start the server with `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` and `DISCORD_REDIRECT_URI` set (same address as the Redirect).
The server asks Discord only for `identify` and `guilds`, keeps your Discord id and name and the ids of your servers (for matching),
and throws the Discord access token away right after sign-in.
