import test from 'node:test';
import assert from 'node:assert/strict';
import { requestCategory, summarizeUsage, utcUsageDay, quota } from '../lib/usage.ts';

test('usage categorization never retains IDs, keys, query strings, or identity data', () => {
  const request = (path, method = 'GET') => new Request('https://shortlist.test' + path, { method });
  for (const [path, method, category] of [
    ['/?list=private-id&key=private-token', 'GET', 'pages'],
    ['/assets/app.js', 'GET', 'assets'],
    ['/api/v1/shortlists/secret-id/export.csv', 'GET', 'shortlist_reads'],
    ['/api/v1/shortlists/secret-id/publish', 'POST', 'shortlist_writes'],
    ['/api/v1/mail-jobs/private-id/complete', 'POST', 'mail'],
    ['/api/v1/queue-status', 'GET', 'mail'],
    ['/api/v1/uploads/private-file', 'GET', 'owner'],
    ['/api/v1/master.csv', 'GET', 'owner'],
    ['/api/v1/usage', 'GET', 'owner'],
    ['/gate/private-owner-entry', 'GET', 'owner'],
    ['/api/v1/session', 'POST', 'auth'],
    ['/oauth/token', 'POST', 'auth'],
    ['/mcp', 'POST', 'agent'],
    ['/api/unknown', 'GET', 'other'],
  ]) assert.equal(requestCategory(request(path, method)), category, path);
});
test('usage day aligns with Cloudflare midnight UTC, including the IST boundary', () => {
  assert.deepEqual(utcUsageDay(Date.parse('2026-11-20T05:29:59+05:30')), { start: '2026-11-19T00:00:00.000Z', reset_at: '2026-11-20T00:00:00.000Z' });
  assert.deepEqual(utcUsageDay(Date.parse('2026-11-20T05:30:00+05:30')), { start: '2026-11-20T00:00:00.000Z', reset_at: '2026-11-21T00:00:00.000Z' });
});
test('unavailable quotas never appear as zero usage or full remaining allowance', () => {
  for (const value of [null, NaN, -1, Infinity]) {
    assert.equal(quota(value, 100000).used, null);
    assert.equal(quota(value, 100000).remaining, null);
    assert.equal(quota(value, 100000).status, 'unavailable');
  }
  assert.equal(quota(0, 100000).remaining, 100000);
  assert.equal(quota(75000, 100000).status, 'warning');
  assert.equal(quota(90000, 100000).status, 'critical');
  assert.equal(quota(110000, 100000).remaining, 0);
  assert.equal(quota(110000, 100000).status, 'exhausted');
});
test('hourly summary separates UTC quota day from the 24 hourly traffic buckets', () => {
  const row = (hour, category, requests, duration) => ({ hour, category, requests, samples: requests / 10, duration_ms: duration, client_errors: 0, server_errors: 0, blocked: 0, slow: 0 });
  const rows = [
    row('2026-11-19T12:00:00.000Z', 'assets', 70, 700),
    row('2026-11-19T23:00:00.000Z', 'pages', 100, 10000),
    row('2026-11-20T00:00:00.000Z', 'shortlist_reads', 200, 60000),
    { ...row('2026-11-20T12:00:00.000Z', 'auth', 10, 100), client_errors: 10, blocked: 10 },
  ];
  const before = structuredClone(rows), result = summarizeUsage(rows, Date.parse('2026-11-20T12:15:00Z'));
  assert.equal(result.today.requests, 210);
  assert.equal(result.today.samples, 21);
  assert.equal(result.last_24_hours.requests, 310);
  assert.equal(result.today.blocked, 10);
  assert.equal(result.today.average_response_ms, 286);
  assert.equal(result.categories.find(row => row.key === 'shortlist_reads').requests, 200);
  assert.equal(result.categories.find(row => row.key === 'pages').requests, 0);
  assert.equal(result.hourly.length, 24);
  assert.equal(result.hourly.reduce((sum, row) => sum + row.requests, 0), 310);
  assert.deepEqual(rows, before);
});
