import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Miniflare } from 'miniflare';

const secretBytes = Buffer.alloc(32, 7);
const call = { jsonrpc: '2.0', id: 1, method: 'events/subscribe', params: { name: 'probe.ready', arguments: { test_id: 'shortlist-check' }, delivery: { mode: 'webhook', url: 'https://connectors.api.openai.com/test-callback', secret: 'whsec_' + secretBytes.toString('base64') } } };

test('Workers runtime sends and verifies the signed challenge before storing the subscription', async () => {
  let calls = 0;
  const outboundService = async request => {
    calls++;
    assert.equal(request.url, call.params.delivery.url);
    const headers = request.headers, body = await request.text();
    const expected = createHmac('sha256', secretBytes).update(headers.get('webhook-id') + '.' + headers.get('webhook-timestamp') + '.' + body).digest('base64');
    assert.equal(headers.get('webhook-signature'), 'v1,' + expected);
    return Response.json({ challenge: JSON.parse(body).challenge });
  };
  const mf = new Miniflare({ modules: true, compatibilityDate: '2026-05-15', scriptPath: new URL('./worker.mjs', import.meta.url).pathname, kvNamespaces: ['PROBE'], outboundService });
  try {
    const response = await mf.dispatchFetch('https://probe.example/mcp', { method: 'POST', body: JSON.stringify(call) });
    const result = await response.json();
    const kv = await mf.getKVNamespace('PROBE');
    const audit = await kv.list({ prefix: 'audit:' });
    const records = await Promise.all(audit.keys.map(key => kv.get(key.name, 'json')));
    assert.ok(result.result?.id.startsWith('sub_'), JSON.stringify({ result, records }));
    assert.equal((await kv.list({ prefix: 'sub:' })).keys.length, 1);
    assert.equal(calls, 1);
  } finally { await mf.dispose(); }
});

test('Workers runtime never follows callback redirects', async () => {
  let calls = 0;
  const outboundService = async request => {
    calls++;
    assert.equal(request.url, call.params.delivery.url);
    return new Response(null, { status: 307, headers: { location: 'https://untrusted.example/callback' } });
  };
  const mf = new Miniflare({ modules: true, compatibilityDate: '2026-05-15', scriptPath: new URL('./worker.mjs', import.meta.url).pathname, kvNamespaces: ['PROBE'], outboundService });
  try {
    const response = await mf.dispatchFetch('https://probe.example/mcp', { method: 'POST', body: JSON.stringify(call) });
    assert.equal((await response.json()).error.code, -32015);
    const kv = await mf.getKVNamespace('PROBE');
    assert.equal((await kv.list({ prefix: 'sub:' })).keys.length, 0);
    const audit = await kv.list({ prefix: 'audit:' });
    const records = await Promise.all(audit.keys.map(key => kv.get(key.name, 'json')));
    assert.ok(records.some(value => value.error?.message === 'Callback redirects are not allowed.'), JSON.stringify(records));
    assert.equal(calls, 1);
  } finally { await mf.dispose(); }
});
