import test from 'node:test';
import assert from 'node:assert/strict';
import { directoryEntries, directoryQuery, searchTokens, buildStudentProfile } from '../lib/student-directory.ts';

const student = { name: 'Synthetic Same Name', roll: '230001', programme: 'BTech', branch: 'Test department', cpi: 0, email: 'synthetic@example.invalid' };
test('search projection retains only the six public student fields and public alternative labels', () => {
  const before = { rows: [{ ...student, private_extra: 'must not escape' }], unresolved_candidates: [{ source_name: 'Synthetic Source', source_index: 50, reason: 'private reason', possible_matches: [{ ...student, roll: '230002' }] }] };
  const data = structuredClone(before), entries = directoryEntries(data);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].kind, 'confirmed');
  assert.equal(entries[1].kind, 'possible');
  assert.equal(entries[1].source_name, 'Synthetic Source');
  assert.equal(entries[0].row.cpi, 0);
  assert.doesNotMatch(JSON.stringify(entries), /must not escape|private reason|source_index/);
  assert.deepEqual(data, before);
});
test('search treats SQL wildcard characters literally and accepts whitespace-separated name tokens', () => {
  assert.equal(directoryQuery('  Synthetic   Same\tName  '), 'Synthetic Same Name');
  assert.deepEqual(searchTokens('SAME  Name'), ['%same%', '%name%']);
  assert.deepEqual(searchTokens('a_b%\\c'), ['%a\\_b\\%\\\\c%']);
});
test('profile de-duplicates each shortlist, favours confirmed identities and preserves separate possible matches', () => {
  const base = { row_data: JSON.stringify(student), kind: 'possible', id: 'one', company: 'Example Pvt. Ltd.', role: 'Analyst', round: 'GD / Interview', season: '2026', added_at: '2026-10-01T00:00:00Z' };
  const input = [{ ...base }, { ...base, kind: 'confirmed' }, { ...base, id: 'two', company: 'Example', added_at: '2026-10-03T00:00:00Z', row_data: JSON.stringify({ ...student, cpi: 9 }) }];
  const profile = buildStudentProfile(input);
  assert.equal(profile.student.cpi, 0, 'Confirmed snapshot is chosen before a newer unconfirmed alternative');
  assert.equal(profile.company_count, 1);
  assert.equal(profile.confirmed.length, 1);
  assert.equal(profile.possible.length, 1);
  assert.equal(profile.confirmed[0].match, 'confirmed');
  assert.deepEqual(profile.confirmed[0].round_categories, ['Group Discussion', 'Interview']);
  assert.equal(buildStudentProfile([]), null);
});
