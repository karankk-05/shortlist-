import test from 'node:test';
import assert from 'node:assert/strict';
import { exportCandidateRows, publicShortlistData, readShortlistData, sameIdentityReviews, validateIdentityReviews } from '../lib/identity-review.ts';
import { validateRows } from '../lib/records.ts';
const master = [
  { name: 'Synthetic Name', roll: '0230001', programme: 'BTech', branch: 'Synthetic A', cpi: 0, email: 'a@example.invalid' },
  { name: 'Synthetic Name', roll: '240002', programme: 'BS', branch: 'Synthetic B', cpi: null, email: 'b@example.invalid' },
];
const pending = { source_name: 'Synthetic Name', source_index: 3, reason: 'Source has no roll and two master names match.', possible_rolls: master.map(row => row.roll) };
test('one ambiguous source entry snapshots all alternatives from the pinned master', () => {
  const result = validateIdentityReviews([pending], master);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].possible_matches, master);
  assert.notEqual(result[0].possible_matches[0], master[0]);
  assert.equal(result[0].possible_matches[0].cpi, 0);
  assert.equal(result[0].possible_matches[1].cpi, null);
});
test('unmatched candidates and single uncertain alternatives remain represented', () => {
  assert.deepEqual(validateIdentityReviews([{ ...pending, possible_rolls: [] }], master)[0].possible_matches, []);
  assert.equal(validateIdentityReviews([{ ...pending, possible_rolls: [master[0].roll] }], master)[0].possible_matches.length, 1);
  assert.deepEqual(validateRows([], true).rows, []);
  assert.throws(() => validateRows([]));
});
test('rejects fabricated option details, absent rolls, duplicate positions and invalid metadata', () => {
  for (const entry of [
    { ...pending, possible_matches: master }, { ...pending, possible_rolls: ['unknown'] },
    { ...pending, possible_rolls: [master[0].roll, master[0].roll] },
    { ...pending, source_index: 0 }, { ...pending, reason: '' }, { ...pending, source_name: '' },
  ]) assert.throws(() => validateIdentityReviews([entry], master));
  assert.throws(() => validateIdentityReviews([pending, pending], master));
});
test('legacy snapshots stay readable; flat exports retain one blank-identity row per ambiguity', () => {
  assert.deepEqual(readShortlistData(master), { rows: master, unresolved_candidates: [] });
  const data = { rows: [master[0]], unresolved_candidates: validateIdentityReviews([pending], master) };
  const exported = exportCandidateRows(data);
  assert.equal(exported.length, 2);
  assert.deepEqual(exported[1], { name: pending.source_name, roll: '', programme: '', branch: '', cpi: null, email: '' });
  assert.deepEqual(data.unresolved_candidates[0].possible_matches, master);
});
test('duplicate detection ignores alternative order but retains uncertainty and source facts', () => {
  const original = validateIdentityReviews([pending], master);
  assert.equal(sameIdentityReviews(original, validateIdentityReviews([{ ...pending, possible_rolls: [...pending.possible_rolls].reverse() }], master)), true);
  assert.equal(sameIdentityReviews(original, []), false);
  assert.equal(sameIdentityReviews(original, validateIdentityReviews([{ ...pending, possible_rolls: [] }], master)), false);
});
test('2026 placement formatting filters only Y24/Y25 BS/BTech alternatives, preserving source counts and snapshots', () => {
  const options = [
    { ...master[0], roll: '230001' },
    { ...master[0], roll: '240001', programme: 'B.S.' },
    { ...master[0], roll: '250001', programme: 'B.Tech' },
    { ...master[0], roll: '240002', programme: 'MTech' },
    { ...master[0], roll: '250003', programme: 'MBA' },
  ];
  const data = { rows: [options[1]], unresolved_candidates: [{ source_name: pending.source_name, source_index: 3, reason: pending.reason, possible_matches: options }] };
  const snapshot = structuredClone(data);
  for (const season of ['2026', '2026–27', '2026-27', '2026/2027']) {
    const result = publicShortlistData(data, { season, role: 'Engineer', round: 'Interview' });
    assert.deepEqual(result.rows, data.rows, 'Explicitly confirmed rows are never removed');
    assert.deepEqual(result.unresolved_candidates[0].possible_matches.map(row => row.roll), ['230001', '240002', '250003']);
    assert.equal(result.unresolved_candidates.length, 1);
    assert.equal('reason' in result.unresolved_candidates[0], false);
  }
  assert.deepEqual(data, snapshot, 'The stored alternatives are preserved');
});
test('internship, other-season and unknown-season displays preserve alternatives', () => {
  const data = { rows: [], unresolved_candidates: [{ source_name: 'Synthetic', source_index: 1, reason: 'Private', possible_matches: [{ ...master[0], roll: '240001' }] }] };
  for (const context of [undefined, { season: '2027', role: 'Engineer' }, { season: 'Unknown', role: 'Engineer' }, { season: '2026', role: 'Software Engineering Intern' }, { season: '2026–27', role: 'Unknown', round: 'Internship test' }]) assert.equal(publicShortlistData(data, context).unresolved_candidates[0].possible_matches.length, 1);
  const empty = publicShortlistData(data, { season: '2026', role: 'Engineer' });
  assert.equal(empty.unresolved_candidates.length, 1, 'A source candidate remains counted even when every alternative is filtered');
  assert.equal(empty.unresolved_candidates[0].possible_matches.length, 0);
});
