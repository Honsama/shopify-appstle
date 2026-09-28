/*
 * ln-box-add.js — the light novel add-on goes onto the box contract as a RECURRING line.
 *
 * Written 2026-09-28 for github.com/Honsama/shopify-appstle (drop this file next to
 * index.js and wire it into addToBoxHandler; README.md in this folder has the exact lines).
 *
 * WHY THIS EXISTS
 *   box-add (the App Proxy route the storefront calls) hardcodes isOneTimeProduct=true for
 *   every variant. That is right for manga and backlist volumes (My Library "Catch up",
 *   title pages, the drawer) and wrong for the light novel add-on, whose page sells "one
 *   brand-new light novel, every month". Confirmed 2026-09-28 on the test account: the
 *   Appstle portal showed "Added as one time purchase only". One book, then nothing.
 *
 * WHAT IT DOES
 *   decideLnAdd(contractPayload) reads the contract's lines (shape-tolerant, the same walk
 *   as Honsama Milestones\ln_reward_sync.py collect_lines) and returns one of:
 *     { action: 'already' }              a paid RECURRING light novel line is on the contract
 *                                        (price >= $1, or a price that cannot be read).
 *     { action: 'replace', lineIds }     paid ONE-TIME light novel line(s) are there (the bug's
 *                                        output): remove every one, then add the recurring line.
 *     { action: 'add' }                  no paid line; a $0 line (the tenure reward copy)
 *                                        does not count as a subscription.
 *   runLnBoxAdd(deps, contractId) performs it through injected calls so the logic is
 *   testable without Appstle: contractGet, contractPut, contractRemove.
 *
 * HOW A ONE-TIME LINE IS RECOGNISED (verified on live renewal orders, 2026-09-28)
 *   Appstle marks one-time products with the line attribute `_appstle-one-time-product: true`
 *   (the tenure perk carries `_appstle-free-product: true` as well). On the renewal ORDER
 *   these ride in customAttributes and the sellingPlan is still set, so the attribute is
 *   the tell, not the plan. On the CONTRACT payload the same information may appear as
 *   `isOneTimeProduct`, as the attribute under customAttributes / attributes / properties,
 *   or as a missing sellingPlanId. All three are read; none found = treated as recurring
 *   (`already`), the safe default the handoff asked for: nobody gets a second copy.
 *
 * Plain CommonJS, no dependencies, no line-ending opinion (index.js is CRLF; this file
 * may stay LF — Node does not care and the diff stays readable).
 */
'use strict';

const LN_VARIANT_ID = '49014826991916';   // Newly Released Vol. 1 Light Novel, $12.74, SKU NLN-1
const LN_PRODUCT_ID = '9388285133100';    // its product (legacy $14.99 contracts match on this)
const PAID_FLOOR = 1.0;                   // below this a line is the $0 reward copy

const PRICE_KEYS = ['currentPrice', 'price', 'discountedPrice', 'lineDiscountedPrice', 'originalPrice', 'unitPrice'];
const TITLE_KEYS = ['title', 'productTitle', 'name'];
const VARIANT_KEYS = ['variantId', 'variant_id', 'productVariantId'];
const PRODUCT_KEYS = ['productId', 'product_id'];
const ATTR_KEYS = ['customAttributes', 'attributes', 'properties', 'lineAttributes'];

function tail(v) {
  if (v === null || v === undefined) return '';
  return String(v).split('/').pop().trim();
}

function num(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') {                    // { amount: "12.74" } or { shopMoney: {...} }
    if (v.amount !== undefined) return num(v.amount);
    if (v.shopMoney) return num(v.shopMoney);
    return null;
  }
  const n = parseFloat(String(v).replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function isLnVariant(variantId) {
  return tail(variantId) === LN_VARIANT_ID;
}

function looksLikeLine(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return false;
  const hasId = 'id' in d || 'lineId' in d;
  const hasName = TITLE_KEYS.some(k => k in d);
  const hasThing = VARIANT_KEYS.some(k => k in d) || PRODUCT_KEYS.some(k => k in d) || 'sku' in d || 'quantity' in d;
  return hasId && hasName && hasThing;
}

function readAttrs(d) {
  const out = {};
  for (const k of ATTR_KEYS) {
    const a = d[k];
    if (Array.isArray(a)) {
      for (const it of a) {
        if (it && typeof it === 'object' && it.key !== undefined) out[String(it.key)] = it.value;
        else if (it && typeof it === 'object' && it.name !== undefined) out[String(it.name)] = it.value;
      }
    } else if (a && typeof a === 'object') {
      Object.assign(out, a);
    }
  }
  return out;
}

function truthy(v) {
  return v === true || String(v).toLowerCase() === 'true';
}

function normalize(d) {
  const attrs = readAttrs(d);
  let price = null;
  for (const k of PRICE_KEYS) {
    const p = num(d[k]);
    if (p !== null) { price = p; break; }
  }
  const variantId = tail(VARIANT_KEYS.map(k => d[k]).find(v => v !== undefined && v !== null && v !== ''));
  const productId = tail(PRODUCT_KEYS.map(k => d[k]).find(v => v !== undefined && v !== null && v !== ''));
  const hasPlanKey = ('sellingPlanId' in d) || ('sellingPlanName' in d) || ('sellingPlan' in d);
  const planEmpty = hasPlanKey && !d.sellingPlanId && !d.sellingPlanName && !d.sellingPlan;
  let oneTime = null;                                   // null = unknown
  if (d.isOneTimeProduct === true || d.oneTimeProduct === true || truthy(attrs['_appstle-one-time-product'])) oneTime = true;
  else if (d.isOneTimeProduct === false || d.oneTimeProduct === false) oneTime = false;
  else if (planEmpty) oneTime = true;
  else if (hasPlanKey) oneTime = false;
  return {
    lineId: String(d.lineId || d.id || ''),
    title: String(TITLE_KEYS.map(k => d[k]).find(v => v) || ''),
    variantId, productId, price,
    free: truthy(attrs['_appstle-free-product']),
    oneTime,
  };
}

/** Walk any Appstle contract payload and return every line-item-shaped object, once. */
function collectLines(node, out, seen) {
  out = out || []; seen = seen || new Set();
  if (typeof node === 'string') {
    const s = node.trim();
    if (s.startsWith('{') || s.startsWith('[')) {
      try { collectLines(JSON.parse(s), out, seen); } catch (e) { /* not JSON */ }
    }
    return out;
  }
  if (Array.isArray(node)) { for (const n of node) collectLines(n, out, seen); return out; }
  if (node && typeof node === 'object') {
    if (looksLikeLine(node)) {
      const line = normalize(node);
      const key = line.lineId + '|' + line.title + '|' + line.variantId;
      if (line.lineId && !seen.has(key)) { seen.add(key); out.push(line); }
    }
    for (const v of Object.values(node)) collectLines(v, out, seen);
  }
  return out;
}

function lnLines(lines) {
  return lines.filter(l => l.variantId === LN_VARIANT_ID || l.productId === LN_PRODUCT_ID);
}

/**
 * The decision. Paid = price >= $1 or unreadable. A $0 line is the reward copy and is ignored.
 * Paid + recurring (or unknown billing type) -> already. Paid + one-time -> replace. Else -> add.
 */
function decideLnAdd(contractPayload) {
  const lines = lnLines(collectLines(contractPayload));
  const paid = lines.filter(l => l.price === null || l.price >= PAID_FLOOR);
  const recurring = paid.find(l => l.oneTime !== true);
  if (recurring) return { action: 'already', lineId: recurring.lineId, lines };
  // Every paid one-time copy goes, not just the first: a subscriber who pressed the
  // button twice under the old code has two queued, and leaving one behind would
  // ship a second book on the next box beside the recurring one.
  const oneTime = paid.filter(l => l.oneTime === true);
  if (oneTime.length) return { action: 'replace', lineId: oneTime[0].lineId, lineIds: oneTime.map(l => l.lineId), lines };
  return { action: 'add', lines };
}

/**
 * deps = {
 *   contractGet(contractId)                       -> the contract-details payload (any shape)
 *   contractPut(path, params)                     -> Appstle PUT through the route's own contractPut()
 *   contractRemove(contractId, lineId)            -> the same call boxRemoveHandler makes
 *   log(msg)                                      -> optional
 * }
 * Returns { ok: true, recurring: true, already?: true, replaced?: true, result?: <Appstle reply> }.
 * Throws whatever the deps throw; the caller keeps the route's 409 JSON contract.
 */
async function runLnBoxAdd(deps, contractId) {
  const log = deps.log || (() => {});
  const payload = await deps.contractGet(contractId);
  const decision = decideLnAdd(payload);
  log(`ln-box-add ${contractId}: ${decision.action} (${decision.lines.length} light novel line(s) read)`);
  if (decision.action === 'already') {
    return { ok: true, recurring: true, already: true };
  }
  if (decision.action === 'replace') {
    for (const lineId of decision.lineIds) await deps.contractRemove(contractId, lineId);
  }
  const result = await deps.contractPut('subscription-contracts-add-line-item', {
    contractId, quantity: 1, variantId: LN_VARIANT_ID, isOneTimeProduct: false,
  });
  const out = { ok: true, recurring: true, result };
  if (decision.action === 'replace') out.replaced = true;
  return out;
}

module.exports = { LN_VARIANT_ID, LN_PRODUCT_ID, PAID_FLOOR, isLnVariant, collectLines, lnLines, decideLnAdd, runLnBoxAdd };
