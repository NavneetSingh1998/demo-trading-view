// "Update available" notice for the desktop app: asks GitHub Releases for the newest version.
// Only the release list is fetched (no data about the user is sent); it can be turned off in
// Settings.

export const RELEASES_API = 'https://api.github.com/repos/keptaduona/wickline/releases/latest';

/** True when version `a` (e.g. "0.2.0" or "v0.2.0") is newer than `b`. Pre-release tags are ignored. */
export function isNewer(a, b) {
  const parse = (v) => String(v || '').replace(/^v/i, '').split(/[-+]/)[0].split('.').map((n) => parseInt(n, 10) || 0);
  const x = parse(a), y = parse(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

/** The newest published release, or null (none yet, offline, rate-limited...). */
export async function latestRelease(fetchImpl = fetch) {
  try {
    const r = await fetchImpl(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' } });
    if (!r.ok) return null;
    const j = await r.json();
    if (j.draft || j.prerelease || !j.tag_name) return null;
    return { version: j.tag_name.replace(/^v/i, ''), url: j.html_url, name: j.name || j.tag_name };
  } catch {
    return null;
  }
}

/**
 * Returns the release to tell the user about, or null: only when it's newer than the running
 * version and the user hasn't dismissed that version.
 */
export async function checkForUpdate({ current, dismissed = null, getLatest = latestRelease }) {
  if (!current) return null;
  const rel = await getLatest();
  if (!rel || !isNewer(rel.version, current)) return null;
  if (dismissed && !isNewer(rel.version, dismissed)) return null;
  return rel;
}
