/*
 * ln-box-add.test.js — offline proof of the decision logic. No network, no secrets.
 *   node ln-box-add.test.js
 * Cases are the ones the 2026-09-28 handoff asked for, plus the payload shapes Appstle has
 * been seen to use (contractDetailsJSON as a JSON string; attributes as key/value arrays).
 */
'use strict';
const assert = require('assert');
const m = require('./ln-box-add');

const LN_V = 'gid://shopify/ProductVariant/49014826991916';
const LN_P = 'gid://shopify/Product/9388285133100';
const BOX_V = 'gid://shopify/ProductVariant/50171151417644';
const BOX_P = 'gid://shopify/Product/8150096773420';

function line(over) {
  return Object.assign({
    lineId: 'gid://shopify/SubscriptionLine/1', title: 'Newly Released Vol. 1 Light Novel', sku: 'NLN-1',
    variantId: LN_V, productId: LN_P, quantity: 1, currentPrice: '12.74', sellingPlanId: 'gid://shopify/SellingPlan/689803198764',
    customAttributes: [],
  }, over || {});
}
const boxLine = { lineId: 'gid://shopify/SubscriptionLine/0', title: "Honsama's Newly Released Monthly Manga Box", sku: 'MMB-3',
  variantId: BOX_V, productId: BOX_P, quantity: 1, currentPrice: '41.99', sellingPlanId: 'gid://shopify/SellingPlan/689803198764', customAttributes: [] };

/** The proxy's contract-details reply: rows whose contractDetailsJSON is a JSON STRING. */
function payload(lines) {
  return [{ subscriptionContractId: 123, status: 'ACTIVE', contractDetailsJSON: JSON.stringify({ lines }) }];
}

let n = 0;
function t(name, fn) { fn(); n++; console.log('  ok  ' + name); }

t('manga variant is not the light novel', () => {
  assert.strictEqual(m.isLnVariant(BOX_V), false);
  assert.strictEqual(m.isLnVariant('49014826991916'), true);
  assert.strictEqual(m.isLnVariant(LN_V), true);
});

t('no light novel line -> add', () => {
  assert.strictEqual(m.decideLnAdd(payload([boxLine])).action, 'add');
});

t('only a $0 reward copy -> add (the perk is not a subscription)', () => {
  const d = m.decideLnAdd(payload([boxLine, line({ currentPrice: '0.00', customAttributes: [
    { key: '_appstle-free-product', value: 'true' }, { key: '_appstle-one-time-product', value: 'true' }] })]));
  assert.strictEqual(d.action, 'add');
});

t('paid recurring line -> already (no PUT)', () => {
  const d = m.decideLnAdd(payload([boxLine, line()]));
  assert.strictEqual(d.action, 'already');
});

t('legacy $14.99 line matched by product id, variant missing -> already', () => {
  const d = m.decideLnAdd(payload([boxLine, line({ variantId: undefined, currentPrice: '14.99' })]));
  assert.strictEqual(d.action, 'already');
});

t('paid ONE-TIME line (attribute) -> replace with its lineId', () => {
  const d = m.decideLnAdd(payload([boxLine, line({ lineId: 'gid://shopify/SubscriptionLine/77',
    customAttributes: [{ key: '_appstle-one-time-product', value: 'true' }] })]));
  assert.strictEqual(d.action, 'replace');
  assert.strictEqual(d.lineId, 'gid://shopify/SubscriptionLine/77');
});

t('two paid ONE-TIME lines (the button pressed twice) -> replace lists both', () => {
  const d = m.decideLnAdd(payload([boxLine, line({ lineId: 'A', customAttributes: [{ key: '_appstle-one-time-product', value: 'true' }] }),
    line({ lineId: 'B', customAttributes: [{ key: '_appstle-one-time-product', value: 'true' }] })]));
  assert.strictEqual(d.action, 'replace');
  assert.deepStrictEqual(d.lineIds, ['A', 'B']);
});

t('paid ONE-TIME line (isOneTimeProduct field) -> replace', () => {
  assert.strictEqual(m.decideLnAdd(payload([boxLine, line({ isOneTimeProduct: true })])).action, 'replace');
});

t('paid line with an empty sellingPlanId -> replace', () => {
  assert.strictEqual(m.decideLnAdd(payload([boxLine, line({ sellingPlanId: null })])).action, 'replace');
});

t('paid line with NO billing-type information at all -> already (safe default)', () => {
  const bare = { id: 'gid://shopify/SubscriptionLine/9', title: 'Newly Released Vol. 1 Light Novel', variantId: LN_V, price: '12.74' };
  assert.strictEqual(m.decideLnAdd(payload([boxLine, bare])).action, 'already');
});

t('unreadable price -> already', () => {
  assert.strictEqual(m.decideLnAdd(payload([boxLine, line({ currentPrice: 'n/a' })])).action, 'already');
});

t('recurring and one-time both present -> already (never stack)', () => {
  const d = m.decideLnAdd(payload([boxLine, line(), line({ lineId: 'x2', customAttributes: [{ key: '_appstle-one-time-product', value: 'true' }] })]));
  assert.strictEqual(d.action, 'already');
});

t('attributes as an object, price as {amount}', () => {
  const d = m.decideLnAdd(payload([boxLine, line({ currentPrice: { amount: '12.74' }, customAttributes: undefined,
    attributes: { '_appstle-one-time-product': true } })]));
  assert.strictEqual(d.action, 'replace');
});

t('garbage payload -> add (nothing readable means nothing there)', () => {
  assert.strictEqual(m.decideLnAdd(null).action, 'add');
  assert.strictEqual(m.decideLnAdd('not json').action, 'add');
  assert.strictEqual(m.decideLnAdd({ a: [1, 2, { b: 'c' }] }).action, 'add');
});

(async () => {
  const calls = [];
  const deps = (rows) => ({
    contractGet: async (id) => { calls.push(['get', id]); return rows; },
    contractPut: async (path, params) => { calls.push(['put', path, params]); return { ok: 1 }; },
    contractRemove: async (id, lineId) => { calls.push(['remove', id, lineId]); return { ok: 1 }; },
  });

  calls.length = 0;
  let r = await m.runLnBoxAdd(deps(payload([boxLine])), '123');
  assert.deepStrictEqual(r, { ok: true, recurring: true, result: { ok: 1 } });
  assert.deepStrictEqual(calls[1], ['put', 'subscription-contracts-add-line-item',
    { contractId: '123', quantity: 1, variantId: '49014826991916', isOneTimeProduct: false }]);
  assert.strictEqual(calls.length, 2);
  n++; console.log('  ok  run: add -> one PUT, quantity 1, isOneTimeProduct=false');

  calls.length = 0;
  r = await m.runLnBoxAdd(deps(payload([boxLine, line()])), '123');
  assert.deepStrictEqual(r, { ok: true, recurring: true, already: true });
  assert.strictEqual(calls.length, 1);
  n++; console.log('  ok  run: already -> no PUT');

  calls.length = 0;
  r = await m.runLnBoxAdd(deps(payload([boxLine, line({ lineId: 'L77', customAttributes: [{ key: '_appstle-one-time-product', value: 'true' }] })])), '123');
  assert.strictEqual(r.replaced, true);
  assert.deepStrictEqual(calls[1], ['remove', '123', 'L77']);
  assert.strictEqual(calls[2][0], 'put');
  n++; console.log('  ok  run: replace -> remove, then PUT');

  calls.length = 0;
  r = await m.runLnBoxAdd(deps(payload([boxLine, line({ lineId: 'A', customAttributes: [{ key: '_appstle-one-time-product', value: 'true' }] }),
    line({ lineId: 'B', customAttributes: [{ key: '_appstle-one-time-product', value: 'true' }] })])), '123');
  assert.strictEqual(r.replaced, true);
  assert.deepStrictEqual(calls.slice(1, 3), [['remove', '123', 'A'], ['remove', '123', 'B']]);
  assert.strictEqual(calls[3][0], 'put'); assert.strictEqual(calls.length, 4);
  n++; console.log('  ok  run: two one-time copies -> both removed, then one PUT');

  calls.length = 0;
  await assert.rejects(m.runLnBoxAdd({ contractGet: async () => { throw new Error('STALE_CONTRACT'); }, contractPut: async () => {}, contractRemove: async () => {} }, '1'));
  n++; console.log('  ok  run: upstream failure propagates to the route (keeps its 409 contract)');

  console.log('\n' + n + ' checks passed');
})().catch(e => { console.error(e); process.exit(1); });
