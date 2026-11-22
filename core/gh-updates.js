'use strict';
// Finds and downloads .studyupdate files from the "Updates" folder of the project's GitHub page.
// `fetchFn` is passed in (Electron's net.fetch in the program, a pretend one in the tests).
const { compare } = require('./semver');

const REPO = 'Grid21/StudyDeck';
const FOLDER = 'Updates';
const NAME = /^StudyDeck-(\d+\.\d+\.\d+)\.studyupdate$/;
const MAX_BYTES = 60 * 1024 * 1024;
const HOSTS = ['raw.githubusercontent.com', 'github.com', 'objects.githubusercontent.com'];

async function findUpdate({ currentVersion, fetchFn, repo = REPO, folder = FOLDER }) {
  let res;
  try { res = await fetchFn(`https://api.github.com/repos/${repo}/contents/${folder}`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'StudyDeck' } }); }
  catch { return { ok: false, error: 'Could not reach GitHub. Check your internet connection.' }; }
  if (res.status === 404) return { ok: true, updateAvailable: false, note: 'No updates have been published yet.' };
  if (res.status === 403 || res.status === 429) return { ok: false, error: 'GitHub says too many checks were made. Try again in a little while.' };
  if (!res.ok) return { ok: false, error: `GitHub answered with error ${res.status}.` };
  let list; try { list = await res.json(); } catch { return { ok: false, error: 'GitHub sent something unexpected.' }; }
  if (!Array.isArray(list)) return { ok: false, error: 'GitHub sent something unexpected.' };
  let best = null;
  for (const f of list) {
    const m = f && f.type === 'file' && NAME.exec(String(f.name));
    if (m && typeof f.download_url === 'string' && (!best || compare(m[1], best.version) > 0)) best = { version: m[1], name: f.name, url: f.download_url, size: f.size };
  }
  if (!best || compare(best.version, currentVersion) <= 0) return { ok: true, updateAvailable: false, currentVersion, latestVersion: best ? best.version : currentVersion };
  return { ok: true, updateAvailable: true, currentVersion, latestVersion: best.version, file: best };
}

// Downloads one update file to `dest`. Only GitHub addresses are accepted. The file is checked again by installUpdate (checksums) before use.
async function downloadUpdate({ file, dest, fetchFn, fs }) {
  let u; try { u = new URL(file.url); } catch { throw new Error('The update address is not valid.'); }
  if (u.protocol !== 'https:' || !HOSTS.includes(u.hostname)) throw new Error('The update address is not a GitHub address, so it was not downloaded.');
  let res;
  try { res = await fetchFn(u.href, { headers: { 'User-Agent': 'StudyDeck' } }); } catch { throw new Error('Could not download the update. Check your internet connection.'); }
  if (!res.ok) throw new Error(`The download failed (error ${res.status}).`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error('The update file is much larger than expected, so it was not used.');
  fs.writeFileSync(dest, buf);
  return dest;
}

module.exports = { findUpdate, downloadUpdate, REPO };
