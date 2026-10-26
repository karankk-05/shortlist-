import test from 'node:test';
import assert from 'node:assert/strict';
import { eventConnectionActive } from '../lib/oauth-grant.ts';

const connection = { user_id: 'owner', grant_id: 'synthetic-grant', principal_id: 'synthetic-access-key' };
const time = Date.parse('2026-10-26T12:00:00Z');
const grant = { id: connection.grant_id, userId: connection.user_id, metadata: { key_id: connection.principal_id }, scope: ['shortlists:read', 'shortlists:write', 'queue:events'], expiresAt: time / 1000 + 3600 };
function fixture(value = grant, failure = false) {
  const counts = { reads: 0, lists: 0 };
  return { counts, env: { OAUTH_KV: {
    async get(key, options) { counts.reads++; assert.equal(key, 'grant:owner:synthetic-grant'); assert.deepEqual(options, { type: 'json', cacheTtl: 30 }); if (failure) throw new Error('synthetic KV outage'); return value; },
    async list() { counts.lists++; throw new Error('Grant enumeration is forbidden'); },
  } } };
}
test('checks the specific event connection with one read and zero grant lists', async () => {
  const { env, counts } = fixture();
  assert.equal(await eventConnectionActive(env, connection, time), true);
  assert.deepEqual(counts, { reads: 1, lists: 0 });
});
test('missing, expired, mismatched or unscoped connections fail closed', async () => {
  for (const value of [null, {}, { ...grant, id: 'other-grant' }, { ...grant, userId: 'other-user' }, { ...grant, metadata: { key_id: 'other-key' } }, { ...grant, scope: ['shortlists:read'] }, { ...grant, expiresAt: time / 1000 }, { ...grant, expiresAt: 'tomorrow' }, { ...grant, expiresAt: NaN }]) {
    const { env, counts } = fixture(value);
    assert.equal(await eventConnectionActive(env, connection, time), false);
    assert.equal(counts.lists, 0);
  }
  const { env } = fixture({ ...grant, expiresAt: undefined });
  assert.equal(await eventConnectionActive(env, connection, time), true, 'The provider supports grants without a TTL');
});
test('invalid storage identifiers never access KV and transient failures remain retryable', async () => {
  const { env, counts } = fixture();
  for (const changes of [{ user_id: 'owner:other' }, { user_id: '' }, { grant_id: ':other' }, { grant_id: '' }, { principal_id: '' }]) assert.equal(await eventConnectionActive(env, { ...connection, ...changes }, time), false);
  assert.deepEqual(counts, { reads: 0, lists: 0 });
  const unavailable = fixture(grant, true);
  await assert.rejects(eventConnectionActive(unavailable.env, connection, time), { message: 'subscription_check_unavailable' });
  assert.equal(unavailable.counts.lists, 0);
});
