'use strict';
const { compare } = require('./semver');

// Asks GitHub whether a newer release exists. `fetchFn` is passed in so this
// works in Electron (net.fetch), Node, or a phone app.
async function checkForUpdate({ repo, currentVersion, fetchFn }) {
  if (!repo || /YOUR-GITHUB-NAME/.test(repo)) {
    return { ok: false, error: 'The GitHub address is not set yet. Edit "homepage" in package.json.' };
  }
  try {
    const res = await fetchFn(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'StudyDeck' }
    });
    if (res.status === 404) return { ok: true, updateAvailable: false, note: 'No releases published yet.' };
    if (!res.ok) return { ok: false, error: `GitHub answered with error ${res.status}.` };
    const rel = await res.json();
    const latest = String(rel.tag_name || '').replace(/^v/, '');
    return {
      ok: true,
      currentVersion,
      latestVersion: latest,
      updateAvailable: compare(latest, currentVersion) > 0,
      url: rel.html_url,
      notes: rel.body || ''
    };
  } catch (e) {
    return { ok: false, error: 'Could not reach GitHub. Check your internet connection.' };
  }
}

// "https://github.com/me/studydeck" or "git+https://github.com/me/studydeck.git" -> "me/studydeck"
function repoFromUrl(url) {
  const m = /github\.com[/:]([^/]+)\/([^/.#]+)/.exec(String(url || ''));
  return m ? `${m[1]}/${m[2]}` : '';
}

module.exports = { checkForUpdate, repoFromUrl };
