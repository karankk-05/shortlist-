import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const keyFile = new URL('../../private/mcp-probe-control.key', import.meta.url);
const base = 'https://shortlist-mcp-event-probe.shortlists.workers.dev';
const action = process.argv[2];
if (action === 'setup') {
  mkdirSync(new URL('../../private/', import.meta.url), { recursive: true, mode: 0o700 });
  if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32).toString('base64url'), { mode: 0o600 });
  const result = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'secret', 'put', 'PROBE_CONTROL_KEY', '--config', '.helper/mcp-event-probe/wrangler.jsonc'], { cwd: new URL('../../', import.meta.url), input: readFileSync(keyFile, 'utf8'), encoding: 'utf8' });
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || ''); process.exitCode = result.status ?? 1;
} else if (action === 'status' || action === 'fire' || action === 'diagnostics') {
  const response = await fetch(base + '/probe/' + action, { method: action === 'fire' ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + readFileSync(keyFile, 'utf8').trim() } });
  console.log(JSON.stringify({ status: response.status, ...await response.json() }, null, 2));
} else if (action === 'health') {
  const response = await fetch(base); console.log(JSON.stringify({ status: response.status, ...await response.json() }));
} else { throw new Error('Use setup, health, status or fire.'); }
