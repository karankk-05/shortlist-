import test from 'node:test';
import assert from 'node:assert/strict';
import { libraryFoldKey, parseLibraryView } from '../lib/library-view.ts';

test('restores separate company, round and role choices plus the filtered browsing context', () => {
  const company = libraryFoldKey('', 'company a');
  const round = libraryFoldKey('', 'company a', 'test');
  const role = libraryFoldKey('', 'company a', 'test', 'analyst');
  const filtered = libraryFoldKey('["company a","Test"]', 'company a', 'test', 'analyst');
  const saved = { query: 'Company A', round: 'Test', expanded: { [company]: true, [round]: true, [role]: false, [filtered]: true }, scrollY: 812 };
  assert.deepEqual(parseLibraryView(JSON.stringify(saved)), saved);
  assert.equal(new Set([company, round, role, filtered]).size, 4);
  assert.notEqual(libraryFoldKey('', 'company a', 'test', 'analyst'), libraryFoldKey('', 'company b', 'test', 'analyst'));
  assert.notEqual(libraryFoldKey('', 'a/b', 'c'), libraryFoldKey('', 'a', 'b/c'));
});

test('unavailable or malformed saved state falls back safely without storing extra fields', () => {
  const empty = { query: '', round: '', expanded: {}, scrollY: 0 };
  for (const value of [null, '', '{broken', 'null', '[]', 'false']) assert.deepEqual(parseLibraryView(value), empty);
  assert.deepEqual(parseLibraryView(JSON.stringify({ query: 123, round: {}, expanded: { a: true, b: false, c: 'false' }, scrollY: -12, rows: [{ roll: 'private' }] })), { ...empty, expanded: { a: true, b: false } });
  assert.deepEqual(parseLibraryView('{"scrollY":1e999,"expanded":[]}'), empty);
});
