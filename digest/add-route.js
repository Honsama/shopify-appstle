/*
 * Shelf Digest — one-tap add ("add from your inbox"), the route logic.
 * Spec: HonsamaOps\Honsama Email Automation\resend_digest\ONE_TAP_ADD_SPEC.md §3–§5.
 *
 * A digest card links to
 *   https://app.honsama.com/api/digest/add?c=<customerId>&v=<variantId>&h=<handle>&m=<YYYY-MM>&t=<hmac>
 *
 *   GET  /api/digest/add       → confirm page with one "Add it" button. NEVER WRITES:
 *                                mail scanners and link previews fetch links before
 *                                anyone reads the email.
 *   POST /api/digest/add       → (the button; same query string) adds ONE line at
 *                                quantity 1 → done page with Undo + Open My Box
 *   POST /api/digest/add-undo  → (&l=<lineId>&u=<undo hmac>) removes exactly the line
 *                                the add created
 *
 * Every check runs on every request: signature, current Pacific month, ACTIVE
 * contract, variant already on the contract. Every outcome is a page.
 *
 * All I/O is injected (index.js wires Appstle / storefront / Admin API; the
 * tests wire fakes), so this file has no network code:
 *   secret                  DIGEST_UNSUB_SECRET
 *   now()                   Date
 *   getContract(c)          → { id, status } for the ACTIVE contract, or null
 *   contractLines(id)       → normalised lines (ln-box-add collectLines)
 *   fetchProduct(handle)    → storefront product JSON, null on 404; throws on failure
 *   addLine(contract, v)    → { data, attempts, ms } | { ln: true, out } (shared add function)
 *   removeLine(contract, l) → resolves when removed
 *   ledgerAdd(c, entry), ledgerUndo(c, lineId)   honsama.digest_adds (best effort)
 *   log(msg), error(msg)
 */
"use strict";
const addToken = require("./add-token");
const { digestPage, escapeHtml } = require("./page");
const { collectLines } = require("../ln-box-add");

const SUPPORT = "<a href=\"mailto:support@honsama.com\" style=\"color:#821e1d;\">support@honsama.com</a>";
const MY_LIBRARY = "https://honsama.com/pages/my-library";
const MY_BOX = "https://honsama.com/apps/subscriptions/";
const ACCOUNT = "https://honsama.com/account";

function q(req, k) { return String((req.query || {})[k] || "").trim(); }
function money(p) { const n = Number(p); return Number.isFinite(n) && n > 0 ? `$${n.toFixed(2)}` : ""; }
function variantOf(product, v) { return ((product && product.variants) || []).find((x) => String(x.id) === v) || null; }
function coverOf(product) { return (product && ((product.image && product.image.src) || (product.images && product.images[0] && product.images[0].src))) || ""; }

const PAGES = {
  notSetUp: () => [503, digestPage("Adding from your inbox isn't set up yet",
    "You can add any volume from My Library in the meantime.", { href: MY_LIBRARY, label: "Open My Library" })],
  invalid: () => [400, digestPage("This link isn't valid",
    "It may have been cut short by your mail app, or it's from an earlier month's email. You can add any volume from My Library.",
    { href: MY_LIBRARY, label: "Open My Library" })],
  paused: () => [200, digestPage("Your box is paused",
    "Adding from your inbox works while your Monthly Manga Box is active. You can manage your subscription from your account.",
    { href: ACCOUNT, label: "Go to my account" })],
  already: (title) => [200, digestPage("Already in your next box",
    `${escapeHtml(title || "This volume")} is already on your next box. Nothing more to do, and no second copy.`,
    null, { links: [{ href: MY_BOX, label: "Open My Box" }] })],
  error: () => [502, digestPage("We couldn't add that just now",
    `Please try again in a few minutes, or write to ${SUPPORT} and we'll add it for you.`,
    { href: MY_LIBRARY, label: "Open My Library" })],
};

function makeDigestAdd(deps) {
  const log = deps.log || (() => {});
  const error = deps.error || (() => {});
  const inFlight = new Map(); // "c:v" -> Promise<[status, html]> — a double tap gets the first tap's answer

  function send(res, page) { res.status(page[0]).set("Cache-Control", "no-store").send(page[1]); }

  // Signature + month. Returns the link's fields, or null after answering.
  function auth(req, res) {
    if (!deps.secret) { send(res, PAGES.notSetUp()); return null; }
    const a = { c: q(req, "c"), v: q(req, "v"), h: q(req, "h"), m: q(req, "m"), t: q(req, "t") };
    if (!addToken.verify(a.c, a.v, a.h, a.m, a.t, deps.secret)) { send(res, PAGES.invalid()); return null; }
    const today = addToken.pacificDate(deps.now());
    if (a.m !== today.ym) { send(res, PAGES.invalid()); return null; }
    // The box locks at 20th 11:59 PM PT. The add itself is identical after it —
    // Appstle bills the line at the next renewal — only the copy changes.
    a.locked = today.day >= 21;
    a.query = `c=${encodeURIComponent(a.c)}&v=${encodeURIComponent(a.v)}&h=${encodeURIComponent(a.h)}&m=${encodeURIComponent(a.m)}&t=${encodeURIComponent(a.t)}`;
    return a;
  }

  async function get(req, res) {
    const a = auth(req, res);
    if (!a) return;
    const startedAt = Date.now();
    try {
      const [contract, product] = await Promise.all([deps.getContract(a.c), deps.fetchProduct(a.h)]);
      const variant = variantOf(product, a.v);
      if (!variant) return send(res, PAGES.invalid()); // product gone, or the variant isn't this product's
      if (!contract) return send(res, PAGES.paused());
      const lines = await deps.contractLines(contract.id);
      if (lines.some((l) => l.variantId === a.v)) return send(res, PAGES.already(product.title));
      log(`digest-add GET: customer ${a.c} variant ${a.v} ${Date.now() - startedAt}ms`);
      const price = money(variant.price);
      const line = (price ? `<strong style="color:#35221b;font-size:16px;">${price}</strong><br>` : "") + (a.locked
        ? "This month's box has locked. Anything you add now goes in the box after: it bills with that renewal on the 21st and ships inside that box."
        : "Bills with your renewal on the 21st and ships inside that box. Remove it any time before the 20th from My Box.");
      return send(res, [200, digestPage(escapeHtml(product.title), line, null, {
        image: coverOf(product),
        form: { action: `/api/digest/add?${a.query}`, label: "Add it" },
        links: a.locked ? [{ href: MY_LIBRARY, label: "Open My Library" }] : [],
      })]);
    } catch (e) {
      error(`digest-add GET: customer ${a.c} variant ${a.v} failed: ${e.message}`);
      return send(res, PAGES.error());
    }
  }

  async function doAdd(a) {
    const startedAt = Date.now();
    // The title is cosmetic, so a storefront hiccup must not block the add; a
    // product that answers 404, or doesn't own this variant, still refuses.
    let product;
    try { product = await deps.fetchProduct(a.h); } catch (e) { product = undefined; }
    if (product === null || (product && !variantOf(product, a.v))) return PAGES.invalid();
    const title = (product && product.title) || "";
    try {
      const contract = await deps.getContract(a.c);
      if (!contract) return PAGES.paused();
      const lines = await deps.contractLines(contract.id);
      const there = lines.find((l) => l.variantId === a.v);
      if (there) return PAGES.already(title || there.title);

      const result = await deps.addLine(contract, a.v);
      if (result.ln && result.out && result.out.already) return PAGES.already(title);
      // The line the add created, for Undo: from the add's own answer, else one re-read.
      let added = collectLines((result && result.data) || {}).find((l) => l.variantId === a.v);
      if (!added) {
        try { added = (await deps.contractLines(contract.id)).find((l) => l.variantId === a.v); } catch (e) { added = null; }
      }
      log(`digest-add: customer ${a.c} variant ${a.v} ${Date.now() - startedAt}ms attempts ${result.attempts || 1}`);
      try {
        await deps.ledgerAdd(a.c, { variantId: a.v, month: a.m, at: deps.now().toISOString(), lineId: (added && added.lineId) || null });
      } catch (e) {
        error(`digest-add: ledger write failed for customer ${a.c} variant ${a.v}: ${e.message}`);
      }
      const name = escapeHtml(title || (added && added.title) || "It");
      const links = [];
      if (added && added.lineId) {
        const u = addToken.signUndo(a.c, a.v, added.lineId, a.m, deps.secret);
        links.push({ form: `/api/digest/add-undo?${a.query}&l=${encodeURIComponent(added.lineId)}&u=${u}`, label: "Undo" });
      }
      links.push({ href: MY_BOX, label: "Open My Box" });
      return [200, digestPage("Added.", a.locked ? `${name} rides in the box after this one.` : `${name} rides in your next box.`,
        null, { image: coverOf(product), links })];
    } catch (e) {
      const upstream = e && e.response && e.response.data;
      error(`digest-add: customer ${a.c} variant ${a.v} failed after ${Date.now() - startedAt}ms: ${(e && e.response && e.response.status) || ""} ${typeof upstream === "object" ? JSON.stringify(upstream) : (upstream || (e && e.message))}`);
      return PAGES.error();
    }
  }

  async function post(req, res) {
    const a = auth(req, res);
    if (!a) return;
    const key = `${a.c}:${a.v}`;
    let job = inFlight.get(key);
    if (!job) {
      job = doAdd(a).finally(() => inFlight.delete(key));
      inFlight.set(key, job);
    }
    return send(res, await job);
  }

  async function undo(req, res) {
    const a = auth(req, res);
    if (!a) return;
    const lineId = q(req, "l");
    if (!addToken.verifyUndo(a.c, a.v, lineId, a.m, q(req, "u"), deps.secret)) return send(res, PAGES.invalid());
    try {
      const contract = await deps.getContract(a.c);
      if (!contract) return send(res, PAGES.paused());
      const line = (await deps.contractLines(contract.id)).find((l) => l.lineId === lineId);
      if (!line) {
        return send(res, [200, digestPage("Already removed", "That volume isn't on your next box any more.",
          null, { links: [{ href: MY_BOX, label: "Open My Box" }] })]);
      }
      await deps.removeLine(contract, lineId);
      log(`digest-add undo: customer ${a.c} variant ${a.v} line ${lineId}`);
      try { await deps.ledgerUndo(a.c, lineId); } catch (e) { error(`digest-add undo: ledger write failed for customer ${a.c}: ${e.message}`); }
      return send(res, [200, digestPage("Removed.", `${escapeHtml(line.title || "That volume")} is off your next box. Nothing is charged for it.`,
        { href: MY_LIBRARY, label: "Open My Library" })]);
    } catch (e) {
      error(`digest-add undo: customer ${a.c} line ${lineId} failed: ${e.message}`);
      return send(res, [502, digestPage("We couldn't remove that just now",
        `It's still on your next box. You can remove it from My Box, or write to ${SUPPORT} and we'll take it off.`,
        null, { links: [{ href: MY_BOX, label: "Open My Box" }] })]);
    }
  }

  return { get, post, undo };
}

module.exports = { makeDigestAdd };
