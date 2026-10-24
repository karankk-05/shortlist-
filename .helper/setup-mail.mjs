import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
if (!process.stdin.isTTY) throw new Error('Run setup:mail interactively in your own terminal. Do not pass credentials as command-line arguments or paste them into a chat.');
let hidden = false;
const output = new Writable({ write(chunk, _encoding, done) { if (!hidden) process.stdout.write(chunk); done(); } });
const terminal = createInterface({ input: process.stdin, output, terminal: true, historySize: 0 });
try {
  console.log('Connect your own IITK mailbox. Credentials go to Worker secrets, never the database, frontend or GitHub.');
  const username = (await terminal.question('IITK mail username (as used for IMAP/webmail): ')).trim();
  if (!username || username.length > 200 || /[^\x20-\x7e]/.test(username)) throw new Error('Invalid mail username.');
  process.stdout.write('IITK IMAP password (hidden): '); hidden = true;
  const password = await terminal.question(''); hidden = false; process.stdout.write('\n');
  if (!password || password.length > 512 || /[^\x20-\x7e]/.test(password)) throw new Error('Use the supported ASCII IMAP password, without newline characters.');
  const secrets = { MAIL_USERNAME: username, MAIL_PASSWORD: password };
  if (process.argv.includes('--local')) {
    let text = ''; try { text = readFileSync('.dev.vars', 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    text = text.replace(/^MAIL_(USERNAME|PASSWORD)=.*\n?/gm, '');
    writeFileSync('.dev.vars', text + (text && !text.endsWith('\n') ? '\n' : '') + Object.entries(secrets).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n', { mode: 0o600 });
    chmodSync('.dev.vars', 0o600);
    console.log('Local mail secrets saved. Restart the local Worker.');
  } else {
    const result = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'secret', 'bulk'], { input: JSON.stringify(secrets), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    if (result.error || result.status !== 0) throw new Error('Cloudflare could not save the mail secrets. Check wrangler login and retry. Credentials were not logged.');
    console.log('Mail secrets saved to the deployed Worker. No redeploy is needed.');
  }
  console.log('Open /mail, adjust lookback/sender settings if needed, and click Sync mailbox. The first successful sync verifies IITK access.');
  console.log('If IITK rejects password-only IMAP, use the login method supported by the institute. Do not disable 2FA or share OTP secrets.');
} finally { terminal.close(); }
