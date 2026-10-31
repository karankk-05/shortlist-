import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Run alongside preview-navigation.mjs. Isolated synthetic headless browser only.
const profile = await mkdtemp(join(tmpdir(), 'shortlist-directory-ui-'));
const chrome = spawn(process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
let socket;
try {
  const endpoint = await new Promise((resolve, reject) => {
    let output = ''; const timer = setTimeout(() => reject(new Error('Synthetic Chrome did not start')), 10000);
    chrome.once('error', reject);
    chrome.stderr.on('data', chunk => { output += chunk; const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
  });
  socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let sequence = 0; const pending = new Map(), errors = [];
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('UI command timed out: ' + method)); }, 10000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data), item = pending.get(message.id);
    if (item) { clearTimeout(item.timer); pending.delete(message.id); message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result); }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId); await send('Runtime.enable', {}, sessionId);
  const evaluate = async expression => {
    const value = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    assert.equal(value.exceptionDetails, undefined, JSON.stringify(value.exceptionDetails)); return value.result.value;
  };
  const until = async expression => {
    for (let attempt = 0; attempt < 80; attempt++) { if (await evaluate('Boolean(' + expression + ')')) return; await new Promise(resolve => setTimeout(resolve, 75)); }
    throw new Error('UI condition not reached: ' + expression);
  };
  const screenshot = async name => { await mkdir('.helper/screenshots', { recursive: true }); const value = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId); await writeFile('.helper/screenshots/' + name + '.png', Buffer.from(value.data, 'base64')); };
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1450, deviceScaleFactor: 1, mobile: false }, sessionId);
  await send('Page.navigate', { url: 'http://127.0.0.1:8791/' }, sessionId);
  await until("document.querySelector('.company-group .group-toggle') && !document.querySelector('.loading')");
  await evaluate("document.querySelector('.company-group .group-toggle').click()");
  await until("document.querySelector('.company-group .group-toggle').getAttribute('aria-expanded') === 'true'");
  await screenshot('student-search-home');
  await evaluate(`{ const input = document.querySelector('[aria-label="Search student name or roll"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Example'); input.dispatchEvent(new Event('input',{bubbles:true})); }`);
  await until("!document.querySelector('.student-search-form button').disabled");
  await evaluate("document.querySelector('.student-search-form').requestSubmit()");
  await until("document.querySelector('.student-search-result')");
  await evaluate("document.querySelector('.student-search-result').click()");
  await until("location.pathname === '/students/230001' && document.querySelector('.student-profile-info')");
  assert.equal(await evaluate("document.querySelector('.student-profile-info .cpi-hidden').textContent"), '...');
  assert.equal(await evaluate("document.querySelector('.library-view').hidden"), true);
  assert.equal(await evaluate("document.querySelectorAll('.student-company').length"), 2);
  assert.equal(await evaluate("document.querySelectorAll('[aria-label=\"Student shortlist statistics\"] .stat').length"), 3);
  assert.equal(await evaluate("document.querySelector('[aria-label=\"Student shortlist statistics\"]').textContent.includes('Unconfirmed shortlist matches')"), true);
  await screenshot('student-profile-desktop');
  await evaluate("document.querySelector('[aria-label=" + JSON.stringify('Show student CPI') + "]').click()");
  assert.equal(await evaluate("document.querySelector('.student-profile-info dl > div:nth-child(3) dd').textContent"), '8.37');
  await evaluate("document.querySelector('.student-company a').click()");
  await until("location.search.includes('list=') && document.querySelector('.student-table')");
  await evaluate('history.back()');
  await until("location.pathname === '/students/230001' && document.querySelector('.student-profile-info')");
  assert.equal(await evaluate("document.querySelector('.student-profile-info .cpi-hidden').textContent"), '...');
  await evaluate('history.back()');
  await until("location.pathname === '/' && !location.search && !document.querySelector('.library-view').hidden");
  assert.equal(await evaluate("document.querySelector('.company-group .group-toggle').getAttribute('aria-expanded')"), 'true');
  assert.equal(await evaluate("document.querySelectorAll('.student-search-result').length"), 1);
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 1200, deviceScaleFactor: 1, mobile: true }, sessionId);
  await send('Page.navigate', { url: 'http://127.0.0.1:8791/students/230001' }, sessionId);
  await until("document.querySelector('.student-profile-info')");
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), true, 'Student profiles fit a mobile viewport');
  await screenshot('student-profile-mobile');
  await send('Page.navigate', { url: 'http://127.0.0.1:8791/students/230002' }, sessionId);
  await until("document.querySelector('.student-profile-info')");
  assert.equal(await evaluate("document.querySelectorAll('[aria-label=\"Student shortlist statistics\"] .stat').length"), 2, 'Zero possible matches must not create a misleading third counter');
  assert.equal(await evaluate("document.querySelector('[aria-label=\"Student shortlist statistics\"]').textContent.includes('matches')"), false);
  assert.equal(await evaluate("getComputedStyle(document.querySelector('[aria-label=\"Student shortlist statistics\"]')).gridTemplateColumns.split(' ').length"), 2, 'The two remaining counters fill the row');
  await screenshot('student-profile-no-ambiguities');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, synthetic_only: true, checked: ['homepage search', 'student profile route', 'loading', 'CPI hidden and revealed', 'confirmed/possible separation', 'company shortlist navigation', 'Back restores open company groups and search results', 'direct profile reload', 'mobile layout'], screenshots: '.helper/screenshots/student-profile-*.png' }));
} finally { socket?.close(); chrome.kill('SIGTERM'); await new Promise(resolve => chrome.exitCode !== null ? resolve() : chrome.once('exit', resolve)); await rm(profile, { recursive: true, force: true }); }
