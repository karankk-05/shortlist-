import { readFileSync } from 'node:fs';

const option = process.argv.indexOf('--credentials-file');
if (option < 0 || !process.argv[option + 1]) throw new Error('Use --credentials-file PATH containing the existing owner key.');
const keys = [...new Set(readFileSync(process.argv[option + 1], 'utf8').match(/own_[A-Za-z0-9_-]{43}/g) || [])];
if (keys.length !== 1) throw new Error('Expected exactly one owner credential.');
let total = 0;
for (let batch = 0; batch < 200; batch++) {
  const response = await fetch('https://shortlist-desk.shortlists.workers.dev/api/v1/student-index', { method: 'POST', headers: { Authorization: 'Bearer ' + keys[0], 'Content-Type': 'application/json' }, body: '{}' });
  const result = await response.json();
  if (!response.ok) throw new Error(`Search indexing failed (${response.status}). Existing source files and publications are unchanged.`);
  total += result.indexed;
  console.log(JSON.stringify({ indexed_this_batch: result.indexed, indexed_total: total, remaining: result.remaining }));
  if (result.remaining === 0) break;
  if (!result.indexed || batch === 199) throw new Error('Search indexing did not finish. Rerun to continue the missing versions.');
}
