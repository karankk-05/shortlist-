import test from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_STUDENT_FILTERS, searchPossibleCandidates, viewStudents, cpiRangeError, studentBatch } from '../lib/student-view.ts';

const base = { programme: 'BTech', branch: 'Test engineering', email: 'synthetic@example.invalid' };
const rows = [
  { ...base, name: 'Zed', roll: '240010', cpi: null },
  { ...base, name: 'Ada', roll: '240002', cpi: 0 },
  { ...base, name: 'Bea', roll: '250003', cpi: 9.5 },
  { ...base, name: 'bea', roll: '240004', cpi: 9.5 },
  { ...base, name: 'Cy', roll: '250005', programme: 'BS', branch: 'Test science', cpi: 8 },
];
const filters = changes => ({ ...EMPTY_STUDENT_FILTERS, ...changes });
test('sorts CPI numerically with zero preserved and missing CPI last in both directions', () => {
  assert.deepEqual(viewStudents(rows, filters({}), 'cpi', 'asc').map(row => row.cpi), [0, 8, 9.5, 9.5, null]);
  assert.deepEqual(viewStudents(rows, filters({}), 'cpi', 'desc').map(row => row.cpi), [9.5, 9.5, 8, 0, null]);
});
test('composes inclusive CPI bounds with programme, branch, batch and case-insensitive search', () => {
  const result = viewStudents(rows, filters({ query: ' BEA ', programme: 'BTech', branch: 'Test engineering', batch: 'Y24', minimumCpi: '9.5', maximumCpi: '9.5' }));
  assert.deepEqual(result.map(row => row.roll), ['240004']);
  assert.equal(viewStudents(rows, filters({ minimumCpi: '0', maximumCpi: '0' }))[0].cpi, 0);
});
test('availability distinguishes a real zero from missing and bounded ranges exclude missing CPI', () => {
  assert.equal(viewStudents(rows, filters({ cpiStatus: 'available' })).length, 4);
  assert.equal(viewStudents(rows, filters({ cpiStatus: 'missing' })).length, 1);
  assert.equal(viewStudents(rows, filters({ minimumCpi: '0' })).length, 4);
});
test('rejects reversed, non-numeric and out-of-range CPI bounds explicitly', () => {
  for (const input of [{ minimumCpi: '9', maximumCpi: '8' }, { minimumCpi: '-1' }, { maximumCpi: '11' }, { minimumCpi: 'abc' }]) {
    assert.ok(cpiRangeError(filters(input)));
    assert.deepEqual(viewStudents(rows, filters(input)), []);
  }
});
test('keeps ties stable and restores source order without mutating the stored shortlist', () => {
  const before = structuredClone(rows);
  assert.deepEqual(viewStudents(rows, filters({}), 'cpi', 'desc').slice(0, 2).map(row => row.roll), ['250003', '240004']);
  assert.deepEqual(viewStudents(rows, filters({}), 'roll', 'asc').map(row => row.roll), ['240002', '240004', '240010', '250003', '250005']);
  assert.deepEqual(viewStudents(rows, filters({})), before);
  assert.deepEqual(rows, before);
  assert.equal(studentBatch(rows[0]), 'Y24');
  assert.equal(studentBatch({ ...rows[0], roll: 'external-2' }), '');
});
const possible = [
  { source_name: 'Dharmesh', possible_matches: [{ ...rows[0], name: 'Dharmesh Example', roll: '230010' }, { ...rows[1], name: 'Dharmesh Second', roll: '230011' }] },
  { source_name: 'Another source name', possible_matches: [{ ...rows[2], name: 'Different Example', email: 'alternative@example.invalid' }] },
  { source_name: 'Pending example', possible_matches: [] },
];
test('searches individual ambiguities and retains all alternatives for the matching source candidate', () => {
  const before = structuredClone(possible);
  assert.deepEqual(searchPossibleCandidates(possible, '  DHARMESH '), [possible[0]]);
  assert.deepEqual(searchPossibleCandidates(possible, '230011'), [possible[0]], 'An alternative roll locates its ambiguity while retaining both possible identities');
  assert.deepEqual(searchPossibleCandidates(possible, 'ALTERNATIVE@EXAMPLE'), [possible[1]]);
  assert.deepEqual(searchPossibleCandidates(possible, 'Different Example'), [possible[1]], 'An alternative name can differ from the source label');
  assert.deepEqual(possible, before);
});
test('ambiguity search handles source-only entries, no matches, whitespace and shared student fields', () => {
  assert.deepEqual(searchPossibleCandidates(possible, 'Pending'), [possible[2]]);
  assert.deepEqual(searchPossibleCandidates(possible, 'not-a-student'), []);
  assert.deepEqual(searchPossibleCandidates(possible, '   '), possible);
  assert.deepEqual(searchPossibleCandidates(possible, 'Test engineering'), possible.slice(0, 2));
  assert.deepEqual(searchPossibleCandidates([], 'Dharmesh'), []);
});
