import { mkdirSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
mkdirSync('backups', { recursive: true, mode: 0o700 });
const filename = `backups/shortlist-${new Date().toISOString().replaceAll(':', '-')}.sql`;
const result = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'd1', 'export', 'DB', '--remote', '--output', filename], { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
chmodSync(filename, 0o600);
console.log(`Private database backup saved to ${filename}. Keep it out of GitHub.`);
