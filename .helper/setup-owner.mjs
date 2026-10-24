import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const key = 'own_' + randomBytes(32).toString('base64url');
const hash = createHash('sha256').update(key).digest('hex');
if (process.argv.includes('--local')) {
  let text = ''; try { text = readFileSync('.dev.vars', 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  text = text.replace(/^ADMIN_KEY_SHA256=.*\n?/gm, '');
  writeFileSync('.dev.vars', text + (text && !text.endsWith('\n') ? '\n' : '') + `ADMIN_KEY_SHA256=${hash}\n`, { mode: 0o600 });
  console.log('LOCAL owner key configured. Restart npm run dev if it is already running.');
} else {
  const result = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'secret', 'put', 'ADMIN_KEY_SHA256'], {
    input: hash + '\n', encoding: 'utf8', stdio: ['pipe', 'inherit', 'inherit'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
  console.log('PRODUCTION owner key configured. Previous owner keys and sessions are now invalid.');
}
console.log('\nSave this private owner key in your password manager. It is shown once:');
console.log(key);
console.log('\nUse it at /admin. Create a separate uploader key there for Gemini.');
