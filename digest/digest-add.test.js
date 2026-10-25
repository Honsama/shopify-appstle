/*
 * digest-add.test.js — offline proof of the one-tap add route (digest/add-route.js).
 *   node digest/digest-add.test.js
 * Injected fakes stand in for Appstle, the storefront and the Admin API; the
 * route runs inside a real Express app on a local port and is called over
 * HTTP, so the pages, statuses and forms are the ones a reader would get.
 * The last case loads index.js itself to prove the wiring and the CORS skip.
 */
'use strict';
const assert = require('assert');
const express = require('express');
const tok = require('./add-token');
const { makeDigestAdd } = require('./add-route');

const S = 'test-secret-0123456789';
const C = '7012345678901', V = '49495541940524', H = 'gokurakugai-vol-2';
const NOV_16 = new Date('2026-11-16T17:00:00Z');   // send day, unlocked
const NOV_22 = new Date('2026-11-22T17:00:00Z');   // after the 20th 11:59 PM PT lock
const DEC_02 = new Date('2026-12-02T17:00:00Z');   // a November link is dead
const PRODUCT = { title: 'Gokurakugai Vol. 2', handle: H, image: { src: 'https://cdn.example/cover.jpg' }, variants: [{ id: Number(V), price: '10.19' }] };
const BOX_LINE = { lineId: 'gid://shopify/SubscriptionLine/box', title: 'Monthly Manga Box', variantId: '50171151417644' };
const NEW_LINE = { lineId: 'gid://shopify/SubscriptionLine/new-1', title: 'Gokurakugai Vol. 2', variantId: V };

// A fake world. `calls` counts every write so "never writes" is checkable.
function world(over) {
  const w = Object.assign({
    now: NOV_16, contract: { id: '555', status: 'ACTIVE' }, lines: [BOX_LINE], product: PRODUCT,
    addFails: false, addDelayMs: 0, addResult: null, productThrows: false, ledgerFails: false, readFails: false,
  }, over || {});
  w.calls = { add: 0, remove: [], ledgerAdd: [], ledgerUndo: [] };
  w.deps = {
    secret: 'secret' in w ? w.secret : S,
    now: () => w.now,
    getContract: async () => { if (w.readFails) throw Object.assign(new Error('boom'), { response: { status: 500, data: { error: 'x' } } }); return w.contract; },
    contractLines: async () => w.lines.slice(),
    fetchProduct: async () => { if (w.productThrows) throw new Error('storefront down'); return w.product; },
    addLine: async () => {
      w.calls.add++;
      if (w.addDelayMs) await new Promise((r) => setTimeout(r, w.addDelayMs));
      if (w.addFails) throw Object.assign(new Error('upstream'), { response: { status: 400, data: { message: 'nope' } } });
      if (w.addResult) return w.addResult;
      w.lines.push(NEW_LINE);
      // Appstle's add answer: the contract, line JSON nested as a string.
      return { attempts: 1, ms: 2400, data: { id: 555, contractDetailsJSON: JSON.stringify({ lines: [BOX_LINE, NEW_LINE] }) } };
    },
    removeLine: async (contract, lineId) => { w.calls.remove.push(lineId); w.lines = w.lines.filter((l) => l.lineId !== lineId); },
    ledgerAdd: async (c, entry) => { if (w.ledgerFails) throw new Error('metafield down'); w.calls.ledgerAdd.push(entry); },
    ledgerUndo: async (c, lineId) => { w.calls.ledgerUndo.push(lineId); },
  };
  return w;
}

async function serve(app) {
  return new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
}

async function run(w, fn) {
  const app = express();
  const h = makeDigestAdd(w.deps);
  app.get('/api/digest/add', h.get);
  app.post('/api/digest/add', h.post);
  app.post('/api/digest/add-undo', h.undo);
  const server = await serve(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { server.close(); }
}

function link(month, over) {
  const o = Object.assign({ c: C, v: V, h: H, m: month || '2026-11' }, over || {});
  return `/api/digest/add?c=${o.c}&v=${o.v}&h=${o.h}&m=${o.m}&t=${o.t || tok.sign(o.c, o.v, o.h, o.m, S)}`;
}
async function req(base, path, method) {
  const r = await fetch(base + path, { method: method || 'GET', redirect: 'manual' });
  return { status: r.status, html: await r.text() };
}
const decode = (s) => s.replace(/&amp;/g, '&');
function formAction(html, label) {
  const re = new RegExp(`<form method="post" action="([^"]+)"[^>]*>\\s*<button[^>]*>${label}</button>`);
  const m = re.exec(html);
  return m ? decode(m[1]) : null;
}

let n = 0;
const cases = [];
function t(name, fn) { cases.push([name, fn]); }

// ---- GET never writes -------------------------------------------------------
t('GET valid link -> confirm page with price, cover and one Add it button; no write', async () => {
  const w = world();
  await run(w, async (b) => {
    const r = await req(b, link());
    assert.strictEqual(r.status, 200);
    assert.match(r.html, /Gokurakugai Vol\. 2/);
    assert.match(r.html, /\$10\.19/);
    assert.match(r.html, /Bills with your renewal on the 21st and ships inside that box\. Remove it any time before the 20th from My Box\./);
    assert.match(r.html, /cover\.jpg/);
    assert.ok(formAction(r.html, 'Add it'), 'Add it is a POST form');
    assert.strictEqual(w.calls.add, 0);
  });
});

t('GET twice (scanner prefetch + reload) -> still no write', async () => {
  const w = world();
  await run(w, async (b) => { await req(b, link()); await req(b, link()); assert.strictEqual(w.calls.add, 0); assert.strictEqual(w.calls.ledgerAdd.length, 0); });
});

t('GET after the lock -> locked copy, still addable, My Library link', async () => {
  const w = world({ now: NOV_22 });
  await run(w, async (b) => {
    const r = await req(b, link());
    assert.strictEqual(r.status, 200);
    assert.match(r.html, /This month's box has locked\. Anything you add now goes in the box after/);
    assert.ok(formAction(r.html, 'Add it'));
    assert.match(r.html, /pages\/my-library/);
    assert.strictEqual(w.calls.add, 0);
  });
});

t('GET variant already on the contract -> Already in your next box', async () => {
  const w = world({ lines: [BOX_LINE, NEW_LINE] });
  await run(w, async (b) => {
    const r = await req(b, link());
    assert.strictEqual(r.status, 200);
    assert.match(r.html, /Already in your next box/);
    assert.strictEqual(formAction(r.html, 'Add it'), null);
  });
});

t('GET paused / cancelled (no ACTIVE contract) -> Your box is paused', async () => {
  const w = world({ contract: null });
  await run(w, async (b) => { const r = await req(b, link()); assert.match(r.html, /Your box is paused/); assert.match(r.html, /honsama\.com\/account/); });
});

t('GET upstream failure -> 502 page, never a blank', async () => {
  const w = world({ readFails: true });
  await run(w, async (b) => { const r = await req(b, link()); assert.strictEqual(r.status, 502); assert.match(r.html, /We couldn't add that just now/); assert.match(r.html, /support@honsama\.com/); });
});

// ---- bad tokens -------------------------------------------------------------
t('invalid: wrong secret, cut short, tampered variant, missing fields -> This link isn\'t valid, no write', async () => {
  const w = world();
  await run(w, async (b) => {
    const bad = [
      link('2026-11', { t: tok.sign(C, V, H, '2026-11', 'other') }),
      link().slice(0, -20),
      link('2026-11', { v: '49495523000620', t: tok.sign(C, V, H, '2026-11', S) }),
      '/api/digest/add',
      `/api/digest/add?c=${C}&v=${V}&h=${H}&m=2026-11`,
    ];
    for (const p of bad) {
      for (const method of ['GET', 'POST']) {
        const r = await req(b, p, method);
        assert.strictEqual(r.status, 400, `${method} ${p}`);
        assert.match(r.html, /This link isn't valid/);
      }
    }
    assert.strictEqual(w.calls.add, 0);
  });
});

t('invalid: a November link in December (GET and POST)', async () => {
  const w = world({ now: DEC_02 });
  await run(w, async (b) => {
    assert.match((await req(b, link('2026-11'))).html, /This link isn't valid/);
    assert.match((await req(b, link('2026-11'), 'POST')).html, /This link isn't valid/);
    assert.strictEqual(w.calls.add, 0);
  });
});

t('invalid: product gone (404) or variant not this product\'s', async () => {
  for (const product of [null, Object.assign({}, PRODUCT, { variants: [{ id: 1, price: '9.99' }] })]) {
    const w = world({ product });
    await run(w, async (b) => {
      assert.match((await req(b, link())).html, /This link isn't valid/);
      assert.match((await req(b, link(), 'POST')).html, /This link isn't valid/);
      assert.strictEqual(w.calls.add, 0);
    });
  }
});

t('secret not set on the server -> 503 "not set up" page, no write', async () => {
  const w = world({ secret: undefined });
  await run(w, async (b) => {
    const r = await req(b, link(), 'POST');
    assert.strictEqual(r.status, 503);
    assert.match(r.html, /isn't set up yet/);
    assert.strictEqual(w.calls.add, 0);
  });
});

// ---- POST adds once ----------------------------------------------------------
t('POST (the Add it button) -> one add, ledger row, done page with Undo + Open My Box', async () => {
  const w = world();
  await run(w, async (b) => {
    const action = formAction((await req(b, link())).html, 'Add it');
    const r = await req(b, action, 'POST');
    assert.strictEqual(r.status, 200);
    assert.match(r.html, /Added\./);
    assert.match(r.html, /Gokurakugai Vol\. 2 rides in your next box\./);
    assert.ok(formAction(r.html, 'Undo'), 'Undo is a POST form');
    assert.match(r.html, /apps\/subscriptions/);
    assert.strictEqual(w.calls.add, 1);
    assert.strictEqual(w.calls.ledgerAdd.length, 1);
    assert.deepStrictEqual(Object.assign({}, w.calls.ledgerAdd[0], { at: 'x' }), { variantId: V, month: '2026-11', at: 'x', lineId: NEW_LINE.lineId });
  });
});

t('POST after the lock -> done page says the box after', async () => {
  const w = world({ now: NOV_22 });
  await run(w, async (b) => { const r = await req(b, link(), 'POST'); assert.match(r.html, /rides in the box after this one/); assert.strictEqual(w.calls.add, 1); });
});

t('POST again later -> Already in your next box, no second copy', async () => {
  const w = world();
  await run(w, async (b) => {
    await req(b, link(), 'POST');
    const r = await req(b, link(), 'POST');
    assert.match(r.html, /Already in your next box/);
    assert.strictEqual(w.calls.add, 1);
  });
});

t('POST double tap in flight -> one add, both taps get the done page', async () => {
  const w = world({ addDelayMs: 150 });
  await run(w, async (b) => {
    const [r1, r2] = await Promise.all([req(b, link(), 'POST'), req(b, link(), 'POST')]);
    assert.strictEqual(w.calls.add, 1);
    assert.match(r1.html, /Added\./);
    assert.match(r2.html, /Added\./);
  });
});

t('POST paused contract -> paused page, no write', async () => {
  const w = world({ contract: null });
  await run(w, async (b) => { assert.match((await req(b, link(), 'POST')).html, /Your box is paused/); assert.strictEqual(w.calls.add, 0); });
});

t('POST Appstle error -> 502 "couldn\'t add" page, no ledger row', async () => {
  const w = world({ addFails: true });
  await run(w, async (b) => {
    const r = await req(b, link(), 'POST');
    assert.strictEqual(r.status, 502);
    assert.match(r.html, /We couldn't add that just now/);
    assert.strictEqual(w.calls.ledgerAdd.length, 0);
  });
});

t('POST light novel already recurring (shared add says already) -> Already page', async () => {
  const w = world({ addResult: { ln: true, out: { ok: true, already: true } } });
  await run(w, async (b) => { assert.match((await req(b, link(), 'POST')).html, /Already in your next box/); });
});

t('POST storefront down -> the add still lands (title is cosmetic)', async () => {
  const w = world({ productThrows: true });
  await run(w, async (b) => { const r = await req(b, link(), 'POST'); assert.match(r.html, /Added\./); assert.strictEqual(w.calls.add, 1); });
});

t('POST ledger write fails -> the reader still gets the done page', async () => {
  const w = world({ ledgerFails: true });
  await run(w, async (b) => { assert.match((await req(b, link(), 'POST')).html, /Added\./); assert.strictEqual(w.calls.add, 1); });
});

t('POST line not findable after the add -> done page without Undo, My Box still linked', async () => {
  const w = world({ addResult: { attempts: 1, ms: 1, data: {} } });
  await run(w, async (b) => {
    const r = await req(b, link(), 'POST');
    assert.match(r.html, /Added\./);
    assert.strictEqual(formAction(r.html, 'Undo'), null);
    assert.match(r.html, /apps\/subscriptions/);
  });
});

// ---- undo -------------------------------------------------------------------
t('Undo removes exactly the added line and marks the ledger', async () => {
  const w = world();
  await run(w, async (b) => {
    const undo = formAction((await req(b, link(), 'POST')).html, 'Undo');
    const r = await req(b, undo, 'POST');
    assert.strictEqual(r.status, 200);
    assert.match(r.html, /Removed\./);
    assert.deepStrictEqual(w.calls.remove, [NEW_LINE.lineId]);
    assert.deepStrictEqual(w.calls.ledgerUndo, [NEW_LINE.lineId]);
    // pressed again: the line is gone, nothing else is touched
    const again = await req(b, undo, 'POST');
    assert.match(again.html, /Already removed/);
    assert.strictEqual(w.calls.remove.length, 1);
  });
});

t('Undo with a swapped lineId -> invalid, nothing removed', async () => {
  const w = world();
  await run(w, async (b) => {
    const undo = formAction((await req(b, link(), 'POST')).html, 'Undo');
    const forged = undo.replace(encodeURIComponent(NEW_LINE.lineId), encodeURIComponent(BOX_LINE.lineId));
    const r = await req(b, forged, 'POST');
    assert.strictEqual(r.status, 400);
    assert.strictEqual(w.calls.remove.length, 0);
  });
});

t('Undo is POST-only (a prefetched GET cannot remove)', async () => {
  const w = world();
  await run(w, async (b) => {
    const undo = formAction((await req(b, link(), 'POST')).html, 'Undo');
    const r = await req(b, undo, 'GET');
    assert.strictEqual(r.status, 404);
    assert.strictEqual(w.calls.remove.length, 0);
  });
});

// ---- index.js wiring ----------------------------------------------------------
t('index.js: routes are mounted and the CORS gate skips /api/digest/* (form POST from app.honsama.com)', async () => {
  process.env.DIGEST_UNSUB_SECRET = S;
  const app = require('../index.js');
  const server = await serve(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const bad = `/api/digest/add?c=${C}&v=${V}&h=${H}&m=2026-11&t=${'0'.repeat(64)}`;
    for (const [method, path] of [['GET', bad], ['POST', bad], ['POST', `/api/digest/add-undo?c=${C}`]]) {
      const r = await fetch(base + path, { method, headers: { Origin: 'https://app.honsama.com' } });
      assert.strictEqual(r.status, 400, `${method} ${path}`);
      assert.match(await r.text(), /This link isn't valid/);
    }
    // the rest of the API keeps its origin check
    const other = await fetch(base + '/api/appstle/box', { headers: { Origin: 'https://evil.example' } });
    assert.strictEqual(other.status, 403);
  } finally { server.close(); }
});

(async () => {
  for (const [name, fn] of cases) {
    await fn();
    n++;
    console.log('  ok  ' + name);
  }
  console.log(`\n${n} checks passed`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
