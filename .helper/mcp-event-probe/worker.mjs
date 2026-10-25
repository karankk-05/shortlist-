const eventName = 'probe.ready';
const version = '2026-07-28';
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const rpc = (id, result) => json({ jsonrpc: '2.0', id, result });
const failure = (id, message, code = -32602) => json({ jsonrpc: '2.0', id, error: { code, message } });
const safeError = error => ({ name: error?.name || 'Error', message: String(error?.message || 'Unknown failure').replace(/https?:\/\/\S+/g, '[callback]').replace(/whsec_[A-Za-z0-9+/_=-]+/g, '[secret]').slice(0, 180) });
async function record(env, method, detail = {}) {
  await env.PROBE.put('audit:' + Date.now() + ':' + crypto.randomUUID(), JSON.stringify({ at: new Date().toISOString(), method, ...detail }), { expirationTtl: 7200 });
}
async function subscriptions(env) {
  const list = await env.PROBE.list({ prefix: 'sub:', limit: 20 });
  const values = await Promise.all(list.keys.map(key => env.PROBE.get(key.name, 'json')));
  return values.filter(Boolean);
}
function callbackUrl(value) {
  const url = new URL(value);
  const allowed = ['chatgpt.com', 'openai.com'].some(host => url.hostname === host || url.hostname.endsWith('.' + host));
  if (!allowed || url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw new Error('Callback must use an OpenAI HTTPS host.');
  return url;
}
function secretBytes(secret) {
  if (typeof secret !== 'string' || !secret.startsWith('whsec_')) throw new Error('Invalid signing secret.');
  const bytes = Uint8Array.from(atob(secret.slice(6)), value => value.charCodeAt(0));
  if (bytes.length < 24 || bytes.length > 64) throw new Error('Invalid signing secret length.');
  return bytes;
}
async function signedDelivery(subscription, value, eventId) {
  const url = callbackUrl(subscription.url), body = JSON.stringify(value), timestamp = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey('raw', secretBytes(subscription.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(eventId + '.' + timestamp + '.' + body));
  // Workers supports manual redirects; reject them without forwarding the signed request.
  const response = await fetch(url.href, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/json', 'webhook-id': eventId, 'webhook-timestamp': timestamp, 'webhook-signature': 'v1,' + btoa(String.fromCharCode(...new Uint8Array(signature))), 'X-MCP-Subscription-Id': subscription.id }, body });
  if (response.status >= 300 && response.status < 400) throw new Error('Callback redirects are not allowed.');
  return response;
}
function equal(left, right) {
  if (typeof right !== 'string' || left.length !== right.length) return false;
  let mismatch = 0;
  for (let i = 0; i < left.length; i++) mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return mismatch === 0;
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/probe/')) {
      if (!env.PROBE_CONTROL_KEY || request.headers.get('Authorization') !== 'Bearer ' + env.PROBE_CONTROL_KEY) return json({ error: 'Unauthorized' }, 401);
      const active = await subscriptions(env);
      if (url.pathname === '/probe/diagnostics' && request.method === 'GET') {
        try {
          const response = await fetch('https://connectors.api.openai.com/', { redirect: 'manual', signal: AbortSignal.timeout(10000) });
          return json({ outbound_status: response.status });
        } catch (error) { return json({ outbound_error: safeError(error) }); }
      }
      if (url.pathname === '/probe/status' && request.method === 'GET') {
        const audit = await env.PROBE.list({ prefix: 'audit:', limit: 100 });
        return json({ methods: (await Promise.all(audit.keys.map(key => env.PROBE.get(key.name, 'json')))).filter(Boolean), subscriptions: active.map(value => ({ id: value.id, callback_host: new URL(value.url).hostname, expires_at: value.expires_at })), last_delivery: await env.PROBE.get('last-delivery', 'json') });
      }
      if (url.pathname === '/probe/fire' && request.method === 'POST') {
        const delivered = [];
        for (const subscription of active) {
          const eventId = 'evt_' + crypto.randomUUID();
          try {
            const response = await signedDelivery(subscription, { eventId, name: eventName, timestamp: new Date().toISOString(), data: { test_id: 'shortlist-check', message: 'Synthetic test event; no mail or student records.', sequence: 1 }, cursor: null }, eventId);
            const result = { event_id: eventId, status: response.status, accepted: response.ok, at: new Date().toISOString() };
            delivered.push(result); await env.PROBE.put('last-delivery', JSON.stringify(result), { expirationTtl: 7200 });
          } catch { delivered.push({ event_id: eventId, accepted: false, error: 'delivery_failed' }); }
        }
        return json({ delivered });
      }
      return json({ error: 'Not found' }, 404);
    }
    if (url.pathname !== '/mcp') return json({ name: 'Shortlist MCP Events capability probe', synthetic_only: true });
    if (request.method === 'GET' || request.method === 'DELETE') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    let call;
    try { const body = await request.text(); if (body.length > 32768) return json({ error: 'Request too large' }, 413); call = JSON.parse(body); } catch { return failure(null, 'Invalid JSON', -32700); }
    const id = call.id ?? null;
    await record(env, typeof call.method === 'string' ? call.method : 'invalid');
    if (call.method?.startsWith('notifications/')) return new Response(null, { status: 202 });
    if (call.method === 'ping') return rpc(id, {});
    if (call.method === 'initialize') return rpc(id, { protocolVersion: ['2025-03-26', '2025-06-18', '2025-11-25', version].includes(call.params?.protocolVersion) ? call.params.protocolVersion : '2025-03-26', capabilities: { tools: {}, events: {} }, serverInfo: { name: 'Shortlist synthetic event probe', version: '1.0.0' }, instructions: 'Capability test only. This server has no access to Shortlist Desk, email, students, credentials or publication.' });
    if (call.method === 'server/discover') return rpc(id, { resultType: 'complete', supportedVersions: [version], capabilities: { tools: {}, events: {} } });
    if (call.method === 'tools/list') return rpc(id, { tools: [{ name: 'probe_status', description: 'Read whether the synthetic MCP event test has an active subscription. No access to email or student data.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }] });
    if (call.method === 'tools/call' && call.params?.name === 'probe_status') return rpc(id, { content: [{ type: 'text', text: JSON.stringify({ synthetic_only: true, subscription_count: (await subscriptions(env)).length }) }] });
    if (call.method === 'resources/list') return rpc(id, { resources: [] });
    if (call.method === 'prompts/list') return rpc(id, { prompts: [] });
    if (call.method === 'events/list') return rpc(id, { events: [{ name: eventName, description: 'A harmless synthetic readiness event for testing ChatGPT MCP Events support. Contains no student or mail data.', delivery: ['webhook'], inputSchema: { type: 'object', properties: { test_id: { type: 'string', enum: ['shortlist-check'] } }, required: ['test_id'], additionalProperties: false }, payloadSchema: { type: 'object', properties: { test_id: { type: 'string' }, message: { type: 'string' }, sequence: { type: 'integer' } }, required: ['test_id', 'message', 'sequence'], additionalProperties: false } }] });
    if (call.method === 'events/subscribe') {
      const params = call.params;
      if (params?.name !== eventName || params.arguments?.test_id !== 'shortlist-check' || params.delivery?.mode !== 'webhook') return failure(id, 'Unsupported test subscription.');
      let callback;
      try { callback = callbackUrl(params.delivery.url); secretBytes(params.delivery.secret); }
      catch { await record(env, 'subscription_rejected', { reason: 'callback_or_secret_invalid' }); return failure(id, 'Only valid OpenAI HTTPS webhook callbacks are accepted.'); }
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(callback.href + eventName));
      const subId = 'sub_' + [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('').slice(0, 32);
      const subscription = { id: subId, url: callback.href, secret: params.delivery.secret, expires_at: new Date(Date.now() + 3600000).toISOString() };
      try {
        const challenge = crypto.randomUUID(), response = await signedDelivery(subscription, { type: 'verification', challenge }, 'verify_' + crypto.randomUUID());
        const result = await response.json().catch(() => null);
        if (!response.ok || !equal(challenge, result?.challenge)) { await record(env, 'verification_failed', { status: response.status, callback_host: callback.hostname }); return failure(id, 'Callback verification failed.', -32015); }
      } catch (error) { await record(env, 'verification_failed', { callback_host: callback.hostname, error: safeError(error) }); return failure(id, 'Callback verification could not complete.', -32015); }
      await env.PROBE.put('sub:' + subId, JSON.stringify(subscription), { expirationTtl: 3600 });
      await record(env, 'subscription_verified', { callback_host: callback.hostname });
      return rpc(id, { id: subId, refreshBefore: subscription.expires_at, cursor: null, truncated: false });
    }
    if (call.method === 'events/unsubscribe') {
      if (call.params?.name !== eventName) return failure(id, 'Unsupported event.');
      for (const subscription of await subscriptions(env)) if (subscription.url === call.params.delivery?.url) await env.PROBE.delete('sub:' + subscription.id);
      return rpc(id, {});
    }
    return failure(id, 'Method not found.', -32601);
  },
};
