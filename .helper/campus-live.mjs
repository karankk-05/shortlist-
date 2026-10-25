import assert from 'node:assert/strict';

// Run from an outside-campus host. Read-only, no keys, mail or student data.
const origin = 'https://shortlist-desk.shortlists.workers.dev';
async function read(path, headers) {
  let url = new URL(path, origin);
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(15000) });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const next = new URL(response.headers.get('Location'), url);
    assert.equal(next.origin, origin, 'Asset canonical redirects must stay on this portal');
    await response.body?.cancel(); url = next;
  }
  throw new Error('Too many redirects');
}
const checks = [
  ['/', 403], ['/index.html', 403], ['/unknown-network-test-route', 403],
  ['/api/v1/shortlists', 403], ['/api/v1/shortlists/network-test', 403],
  ['/api/v1/shortlists/network-test/export.csv', 403],
  ['/.well-known/oauth-authorization-server', 200], ['/.well-known/oauth-protected-resource/mcp', 200],
  ['/mcp', 401], ['/shortlist-plugin.png', 200], ['/upload', 200],
];
for (const [path, expected] of checks) {
  const response = await read(path);
  assert.equal(response.status, expected, path);
  if (expected === 403) {
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    if (path.startsWith('/api/')) assert.equal((await response.json()).code, 'iitk_network_required');
    else assert.match(await response.text(), /IITK network required/);
  } else await response.body?.cancel();
  console.log(JSON.stringify({ path, status: response.status }));
}
const spoofed = await read('/api/v1/shortlists', { 'CF-Connecting-IP': '14.139.38.102', 'X-Forwarded-For': '14.139.38.102', 'X-Real-IP': '14.139.38.102' });
assert.equal(spoofed.status, 403);
assert.equal((await spoofed.json()).code, 'iitk_network_required');
console.log(JSON.stringify({ passed: true, outside_campus_denied: true, forged_campus_headers_denied: true, oauth_and_login_available: true, student_data_read: false }));
