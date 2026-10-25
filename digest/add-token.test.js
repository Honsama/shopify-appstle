/*
 * add-token.test.js — offline proof of the one-tap link signing. No network, no secrets.
 *   node digest/add-token.test.js
 */
'use strict';
const assert = require('assert');
const tok = require('./add-token');
const unsub = require('./unsub-token');

const S = 'test-secret-0123456789';
const C = '7012345678901', V = '49495541940524', H = 'gokurakugai-vol-2', M = '2026-11';

let n = 0;
function t(name, fn) { fn(); n++; console.log('  ok  ' + name); }

t('round trip verifies', () => {
  assert.strictEqual(tok.verify(C, V, H, M, tok.sign(C, V, H, M, S), S), true);
});

t('wrong secret fails', () => {
  assert.strictEqual(tok.verify(C, V, H, M, tok.sign(C, V, H, M, 'other'), S), false);
});

t('cut-short token fails', () => {
  assert.strictEqual(tok.verify(C, V, H, M, tok.sign(C, V, H, M, S).slice(0, 40), S), false);
});

t('another month fails (a November link is not a December link)', () => {
  assert.strictEqual(tok.verify(C, V, H, '2026-12', tok.sign(C, V, H, M, S), S), false);
});

t('tampered customer / variant / handle fail', () => {
  const good = tok.sign(C, V, H, M, S);
  assert.strictEqual(tok.verify('7012345678902', V, H, M, good, S), false);
  assert.strictEqual(tok.verify(C, '49495523000620', H, M, good, S), false);
  assert.strictEqual(tok.verify(C, V, 'gokurakugai-vol-3', M, good, S), false);
});

t('malformed fields fail before any HMAC', () => {
  const good = tok.sign(C, V, H, M, S);
  assert.strictEqual(tok.verify('', V, H, M, good, S), false);
  assert.strictEqual(tok.verify(C, 'gid://shopify/ProductVariant/1', H, M, good, S), false);
  assert.strictEqual(tok.verify(C, V, '../admin', M, good, S), false);
  assert.strictEqual(tok.verify(C, V, H, '2026-13', good, S), false);
  assert.strictEqual(tok.verify(C, V, H, M, good, ''), false);
});

t('an unsubscribe token never passes as an add token (domain-separated prefixes)', () => {
  assert.strictEqual(tok.verify(C, V, H, M, unsub.sign(C, S), S), false);
});

t('undo token binds the line', () => {
  const L = 'gid://shopify/SubscriptionLine/abc-123';
  const u = tok.signUndo(C, V, L, M, S);
  assert.strictEqual(tok.verifyUndo(C, V, L, M, u, S), true);
  assert.strictEqual(tok.verifyUndo(C, V, 'gid://shopify/SubscriptionLine/other', M, u, S), false);
  assert.strictEqual(tok.verifyUndo(C, V, L, M, tok.sign(C, V, H, M, S), S), false);
});

t('addUrl carries every field and a verifying token', () => {
  const u = new URL(tok.addUrl('https://app.honsama.com/', C, V, H, M, S));
  assert.strictEqual(u.origin + u.pathname, 'https://app.honsama.com/api/digest/add');
  const p = u.searchParams;
  assert.deepStrictEqual([p.get('c'), p.get('v'), p.get('h'), p.get('m')], [C, V, H, M]);
  assert.strictEqual(tok.verify(C, V, H, M, p.get('t'), S), true);
});

t('pacificDate: the box locks at 20th 11:59 PM PT', () => {
  assert.deepStrictEqual(tok.pacificDate(new Date('2026-11-21T07:59:00Z')), { year: 2026, month: 11, day: 20, ym: '2026-11' });
  assert.strictEqual(tok.pacificDate(new Date('2026-11-21T08:00:00Z')).day, 21);
  assert.strictEqual(tok.pacificDate(new Date('2026-12-01T07:00:00Z')).ym, '2026-11'); // still Nov 30 in PT
});

console.log(`\n${n} checks passed`);
