import test from 'node:test';
import assert from 'node:assert/strict';
import { companyKey, groupShortlists, roundCategories } from '../lib/shortlist-groups.ts';

test('test and interview aliases share filters while dates remain source data', () => {
  for (const label of ['Test', 'Technical Test', 'Online Aptitude Test — 10 October 2026, 1:30 PM', 'Online assessment', 'OA', 'O.A.', 'Coding round', 'Written test']) assert.deepEqual(roundCategories(label), ['Test'], label);
  for (const label of ['Interview', 'Technical Interview 2', 'HR interview', 'Personal Interview', 'PI', 'P.I.', 'HR round']) assert.deepEqual(roundCategories(label), ['Interview'], label);
});

test('GD, buddy and mixed stages remain distinct and discoverable', () => {
  for (const label of ['GD', 'G.D.', 'Group discussion', 'Group Discussion — 25 October']) assert.deepEqual(roundCategories(label), ['Group Discussion'], label);
  assert.deepEqual(roundCategories('Buddy interview'), ['Buddy Round']);
  assert.deepEqual(roundCategories('Buddy Round'), ['Buddy Round']);
  assert.deepEqual(roundCategories('GD / PI'), ['Group Discussion', 'Interview']);
  assert.deepEqual(roundCategories('Test and Interview'), ['Test', 'Interview']);
  assert.deepEqual(roundCategories('Case study'), ['Case Study']);
});

test('unrecognized rounds are preserved rather than guessed from partial words', () => {
  for (const label of ['Eligible Students', 'Contest', 'Testimony', 'Technical Round 1']) assert.deepEqual(roundCategories(label), [label]);
  assert.deepEqual(roundCategories('  Portfolio   review  '), ['Portfolio review']);
});

test('company identity groups case, punctuation and legal suffixes without fuzzy name merging', () => {
  const key = companyKey('SEDEMAC Mechatronics Limited');
  assert.equal(companyKey('  sedemac  mechatronics LTD. '), key);
  assert.equal(companyKey('Sedemac Mechatronics Pvt. Ltd.'), key);
  assert.equal(companyKey('Research & Development Inc.'), companyKey('Research and Development'));
  assert.notEqual(companyKey('Acme Finance Ltd'), companyKey('Acme Financial Ltd'));
  assert.notEqual(companyKey('Acme Bank'), companyKey('Acme Capital'));
  assert.notEqual(companyKey('C++ Labs'), companyKey('C Labs'));
});

test('non-adjacent company rows are grouped by newest source date with every event intact', () => {
  const rows = [
    { id: 'alpha-old', company: 'Alpha Ltd.', role: 'Hardware', round: 'Technical Test', season: '2026', added_at: '2026-10-10T00:00:00.000Z' },
    { id: 'beta', company: 'Beta', role: 'Developer', round: 'GD', season: '2026', added_at: '2026-10-24T00:00:00.000Z' },
    { id: 'alpha-new', company: 'ALPHA Limited', role: 'Hardware', round: 'Online Aptitude Test — 25 October 2026, 1:30 PM', season: '2026', added_at: '2026-10-25T00:00:00.000Z' },
    { id: 'alpha-interview', company: 'Alpha', role: 'Developer', round: 'Technical Interview', season: '2025', added_at: '2025-10-10T00:00:00.000Z' },
  ];
  const original = structuredClone(rows);
  rows.forEach(Object.freeze); Object.freeze(rows);
  const result = groupShortlists(rows);
  assert.deepEqual(result.company_groups.map(group => group.key), ['alpha', 'beta']);
  assert.deepEqual(result.company_groups[0].shortlists.map(row => row.id), ['alpha-new', 'alpha-old', 'alpha-interview']);
  assert.equal(result.company_groups[0].added_at, original[2].added_at);
  assert.deepEqual(result.round_categories, ['Test', 'Group Discussion', 'Interview']);
  assert.equal(result.company_groups[0].shortlists.filter(row => row.round_categories.includes('Test')).length, 2);
  const grouped = result.company_groups.flatMap(group => group.shortlists);
  assert.equal(grouped.length, original.length);
  for (const row of original) {
    const { round_categories, ...source } = grouped.find(value => value.id === row.id);
    assert.deepEqual(source, row, 'Keep exact company, role, round, season and dates');
  }
  assert.deepEqual(rows, original, 'Do not mutate persisted/source records');
});

test('empty indexes and equal dates produce stable company groups', () => {
  assert.deepEqual(groupShortlists([]), { company_groups: [], round_categories: [] });
  const rows = ['Zulu', 'Alpha'].map(company => ({ id: company, company, round: 'Test', added_at: '2026-10-25T00:00:00Z' }));
  assert.deepEqual(groupShortlists(rows).company_groups.map(group => group.company), ['Alpha', 'Zulu']);
});
