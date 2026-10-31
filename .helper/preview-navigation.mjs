import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { groupShortlists } from '../lib/shortlist-groups.ts';

// Local UI fixture: synthetic records and deliberately slow detail requests only.
const root = resolve(new URL('../dist/', import.meta.url).pathname);
const listing = (id, company, round = 'Technical Test', role = 'Analyst', day = 1) => ({ id, company, role, round, season: '2026', notes: '', published_version_id: 'synthetic-version', row_count: 1, unresolved_count: 0, added_at: `2026-10-${String(day).padStart(2, '0')}T00:00:00Z`, updated_at: '2026-10-25T00:00:00Z', version_number: 1, version_count: 1 });
const lists = [...Array.from({ length: 18 }, (_, i) => listing(`sample-${i}`, `Sample Company ${i + 1}`, 'Technical Test', 'Analyst', 25 - i)), listing('example-test', 'Example Company'), listing('example-oa', 'Example Company', 'Online Aptitude Test'), listing('example-interview', 'Example Company', 'Interview', 'Engineer')];
const json = (response, status, value) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); };
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1:8791');
  if (url.pathname === '/api/v1/me') return json(response, 200, { role: 'public', label: null, owner_configured: true });
  if (url.pathname === '/api/v1/shortlists') return json(response, 200, { shortlists: lists, ...groupShortlists(lists) });
  const student = { name: 'Example Student', roll: '230001', programme: 'BTech', branch: 'Example Engineering', cpi: 8.37, email: 'example23@example.invalid' };
  if (url.pathname === '/api/v1/students') {
    const { cpi: _cpi, ...summary } = student;
    return json(response, 200, { query: url.searchParams.get('q'), students: [{ student: summary, confirmed_count: 2, possible_count: 1 }], has_more: false, next_offset: null });
  }
  if (url.pathname === '/api/v1/students/230001') {
    await new Promise(resolve => setTimeout(resolve, 300));
    return json(response, 200, { student, confirmed: lists.filter(row => ['example-test', 'example-interview'].includes(row.id)).map(row => ({ ...row, match: 'confirmed', round_categories: [row.round] })), possible: [{ ...lists[0], match: 'possible', round_categories: ['Test'] }], company_count: 2 });
  }
  if (url.pathname.startsWith('/api/v1/shortlists/')) {
    await new Promise(done => setTimeout(done, 2500));
    const shortlist = lists.find(list => list.id === url.pathname.split('/').at(-1));
    return shortlist ? json(response, 200, { shortlist, rows: [{ name: 'Example Student', roll: '230001', programme: 'BTech', branch: 'Example department', cpi: 8, email: 'student@example.test' }], unresolved_candidates: [], version: { id: 'synthetic-version', number: 1, row_count: 1, unresolved_count: 0 } }) : json(response, 404, { error: 'Shortlist not found.' });
  }
  if (url.pathname.startsWith('/api/')) return json(response, 404, { error: 'Not found.' });
  const file = resolve(root, url.pathname === '/' || url.pathname.startsWith('/students/') ? 'index.html' : '.' + url.pathname);
  if (!file.startsWith(root + '/')) { response.writeHead(404); response.end(); return; }
  try {
    const bytes = await readFile(file);
    response.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); response.end(bytes);
  } catch { response.writeHead(404); response.end(); }
});
server.listen(8791, '127.0.0.1', () => console.log('Synthetic navigation preview: http://127.0.0.1:8791'));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close());
