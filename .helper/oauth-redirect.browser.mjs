import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolated headless Chrome; synthetic form only, no user profile or real network callback.
export async function verifyConsentRedirectInChrome(policy) {
  const profile = await mkdtemp(join(tmpdir(), 'shortlist-oauth-browser-'));
  const server = createServer(async (request, response) => {
    const old = request.url.includes('old');
    if (request.method === 'POST') {
      let body = ''; for await (const chunk of request) body += chunk;
      assert.equal(body, 'owner_key=synthetic-only');
      response.writeHead(303, { Location: 'https://chatgpt.com/connector_platform_oauth_redirect?code=synthetic-only' });
      response.end(); return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html', 'Referrer-Policy': 'same-origin', 'Content-Security-Policy': old ? policy.replace("form-action 'self' https://chatgpt.com", "form-action 'self'") : policy });
    response.end('<!doctype html><form method="post"><input name="owner_key" value="synthetic-only"><button>Connect</button></form>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const chrome = spawn(process.env.CHROME_BIN, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let socket;
  try {
    const endpoint = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Headless Chrome did not start')), 10000);
      chrome.once('error', error => { clearTimeout(timer); reject(error); });
      chrome.stderr.on('data', chunk => { output += chunk; const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
    });
    socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    let sequence = 0, callbacks = 0;
    const pending = new Map();
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('Chrome command timed out: ' + method)); }, 10000);
      pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data), entry = pending.get(message.id);
      if (entry) { clearTimeout(entry.timer); pending.delete(message.id); message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result); }
      if (message.method === 'Fetch.requestPaused') {
        if (new URL(message.params.request.url).pathname === '/connector_platform_oauth_redirect') callbacks++;
        assert.equal(message.params.request.method, 'GET', 'The owner-key POST body must never reach ChatGPT');
        send('Fetch.fulfillRequest', { requestId: message.params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html' }], body: Buffer.from('<p>Synthetic callback reached</p>').toString('base64') }, message.sessionId).catch(() => {});
      }
    });
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Page.enable', {}, sessionId);
    await send('Fetch.enable', { patterns: [{ urlPattern: 'https://chatgpt.com/*' }] }, sessionId);
    for (const mode of ['old', 'fixed']) {
      await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/${mode}` }, sessionId);
      let ready = false;
      for (let n = 0; n < 40 && !ready; n++) {
        ready = (await send('Runtime.evaluate', { expression: "!!document.querySelector('button')", returnByValue: true }, sessionId)).result.value;
        if (!ready) await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.equal(ready, true);
      const before = callbacks;
      await send('Runtime.evaluate', { expression: "document.querySelector('button').click()" }, sessionId);
      await new Promise(resolve => setTimeout(resolve, 1000));
      assert.equal(callbacks - before, mode === 'old' ? 0 : 1, 'Chrome must block the old policy and follow the fixed callback');
    }
    console.log(JSON.stringify({ browser_oauth_redirect: 'passed', old_policy_blocked: true, fixed_policy_followed: true, synthetic_only: true }));
  } finally {
    socket?.close();
    const stopped = new Promise(resolve => chrome.once('exit', resolve));
    chrome.kill('SIGTERM'); await stopped;
    await new Promise(resolve => server.close(resolve));
    await rm(profile, { recursive: true, force: true });
  }
}
