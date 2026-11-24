// Tests for public/js/update.js: version comparison and when the update notice shows.
import assert from 'node:assert/strict';
import { isNewer, checkForUpdate, latestRelease, RELEASES_API } from '../public/js/update.js';

let failed = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};

await test('compares versions numerically', () => {
  assert.equal(isNewer('0.2.0', '0.1.0'), true);
  assert.equal(isNewer('v0.10.0', '0.9.9'), true);
  assert.equal(isNewer('1.0', '0.99.99'), true);
  assert.equal(isNewer('0.1.0', '0.1.0'), false);
  assert.equal(isNewer('0.1.0', '0.2.0'), false);
  assert.equal(isNewer('0.2.0-beta.1', '0.2.0'), false);
});

const release = (version) => async () => ({ version, url: `https://github.com/x/releases/tag/v${version}` });

await test('shows a newer release', async () => {
  const rel = await checkForUpdate({ current: '0.1.0', getLatest: release('0.2.0') });
  assert.equal(rel?.version, '0.2.0');
});

await test('stays quiet on the same or an older release', async () => {
  assert.equal(await checkForUpdate({ current: '0.2.0', getLatest: release('0.2.0') }), null);
  assert.equal(await checkForUpdate({ current: '0.3.0', getLatest: release('0.2.0') }), null);
});

await test('stays quiet for a dismissed version, speaks up for the next one', async () => {
  assert.equal(await checkForUpdate({ current: '0.1.0', dismissed: '0.2.0', getLatest: release('0.2.0') }), null);
  assert.equal((await checkForUpdate({ current: '0.1.0', dismissed: '0.2.0', getLatest: release('0.3.0') }))?.version, '0.3.0');
});

await test('stays quiet when there is no release or no network', async () => {
  assert.equal(await checkForUpdate({ current: '0.1.0', getLatest: async () => null }), null);
  assert.equal(await latestRelease(async () => ({ ok: false, status: 404 })), null);
  assert.equal(await latestRelease(async () => { throw new Error('offline'); }), null);
});

await test('reads GitHub\'s latest-release response', async () => {
  let asked = null;
  const rel = await latestRelease(async (url) => {
    asked = url;
    return { ok: true, json: async () => ({ tag_name: 'v0.2.0', html_url: 'https://github.com/keptaduona/wickline/releases/tag/v0.2.0', draft: false, prerelease: false }) };
  });
  assert.equal(asked, RELEASES_API);
  assert.deepEqual(rel, { version: '0.2.0', url: 'https://github.com/keptaduona/wickline/releases/tag/v0.2.0', name: 'v0.2.0' });
});

await test('ignores drafts and pre-releases', async () => {
  const fake = (extra) => async () => ({ ok: true, json: async () => ({ tag_name: 'v9.0.0', html_url: 'x', ...extra }) });
  assert.equal(await latestRelease(fake({ draft: true })), null);
  assert.equal(await latestRelease(fake({ prerelease: true })), null);
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exitCode = failed ? 1 : 0;
