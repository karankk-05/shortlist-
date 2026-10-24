import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const path = '/gate/' + randomBytes(24).toString('hex');
if (process.argv.includes('--local')) {
  let vars = ''; try { vars = readFileSync('.dev.vars', 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  vars = vars.replace(/^OWNER_ENTRY_PATH=.*\n?/gm, '');
  writeFileSync('.dev.vars', vars + (vars && !vars.endsWith('\n') ? '\n' : '') + `OWNER_ENTRY_PATH=${path}\n`, { mode: 0o600 });
} else {
  const result = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'secret', 'put', 'OWNER_ENTRY_PATH'], { input: path + '\n', encoding: 'utf8', stdio: ['pipe', 'inherit', 'inherit'] });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
mkdirSync('private', { recursive: true, mode: 0o700 });
const saved = process.argv.includes('--local') ? 'private/owner-entry-path.local.txt' : 'private/owner-entry-path.txt';
writeFileSync(saved, path + '\n', { mode: 0o600 });
console.log(`Owner entry path saved to ${saved}. Append it to the site origin and bookmark that URL. Existing owner keys are unchanged.`);
