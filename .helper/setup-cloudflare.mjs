import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const cli = 'node_modules/wrangler/bin/wrangler.js';
const configPath = 'wrangler.jsonc';
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const database = config.d1_databases[0];
const placeholder = '00000000-0000-0000-0000-000000000000';

function run(args, capture = false) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', stdio: capture ? ['inherit', 'pipe', 'inherit'] : 'inherit' });
  if (capture && result.stdout) process.stdout.write(result.stdout);
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
  return result.stdout || '';
}
if (database.database_id === placeholder) {
  const output = run(['d1', 'create', database.database_name, '--location', 'apac', '--update-config=false'], true);
  const match = output.match(/database_id["']?\s*[:=]\s*["']?([a-f0-9-]{36})/i);
  if (!match) throw new Error('Copy the database_id printed above into wrangler.jsonc, then rerun this command.');
  database.database_id = match[1];
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
}
run(['d1', 'migrations', 'apply', 'DB', '--remote']);
console.log('\nDatabase ready. Next: npm run deploy, then npm run setup:owner.');
