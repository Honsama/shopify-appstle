/*
 * Shelf Digest — one-tap add link signing (shared by send-resend.js and the
 * box app's /api/digest/add route in ../index.js). Mirror of unsub-token.js.
 *
 * token = HMAC-SHA256(DIGEST_UNSUB_SECRET, "digest-add:<customerId>:<variantId>:<handle>:<YYYY-MM>")
 * The SAME secret as the unsubscribe link (spec §8 A, Ricky 2026-10-25), kept
 * apart by the "digest-add:" prefix, so an unsubscribe token can never pass
 * as an add token or the other way round. Nothing new to copy into Vercel.
 *
 * The month is part of the signature: the route only accepts the current
 * Pacific month, so a November link cannot add anything in December.
 *
 * The Undo button on the done page carries its own token over the line the
 * add created ("digest-add-undo:<customerId>:<variantId>:<lineId>:<YYYY-MM>"),
 * so a done page can only ever remove the line it added.
 */
const crypto = require("crypto");

function hmac(message, secret) {
  if (!secret) throw new Error("DIGEST_UNSUB_SECRET is not set");
  return crypto.createHmac("sha256", secret).update(message).digest("hex");
}

function safeHexEqual(expected, given) {
  if (!/^[0-9a-f]{64}$/.test(String(given || ""))) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(String(given));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const HANDLE_RE = /^[a-z0-9][a-z0-9-]{0,254}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function sign(customerId, variantId, handle, month, secret) {
  return hmac(`digest-add:${customerId}:${variantId}:${handle}:${month}`, secret);
}

function verify(customerId, variantId, handle, month, token, secret) {
  if (!secret || !/^\d+$/.test(String(customerId || "")) || !/^\d+$/.test(String(variantId || ""))
    || !HANDLE_RE.test(String(handle || "")) || !MONTH_RE.test(String(month || ""))) return false;
  return safeHexEqual(sign(customerId, variantId, handle, month, secret), token);
}

function signUndo(customerId, variantId, lineId, month, secret) {
  return hmac(`digest-add-undo:${customerId}:${variantId}:${lineId}:${month}`, secret);
}

function verifyUndo(customerId, variantId, lineId, month, token, secret) {
  if (!secret || !lineId) return false;
  return safeHexEqual(signUndo(customerId, variantId, lineId, month, secret), token);
}

function addUrl(base, customerId, variantId, handle, month, secret) {
  const q = `c=${encodeURIComponent(customerId)}&v=${encodeURIComponent(variantId)}&h=${encodeURIComponent(handle)}&m=${encodeURIComponent(month)}`;
  return `${String(base).replace(/\/+$/, "")}/api/digest/add?${q}&t=${sign(customerId, variantId, handle, month, secret)}`;
}

// Today's date in the store's time zone (the 21st cutoff is 20th 11:59 PM PT).
// Returns { year, month, day, ym: "YYYY-MM" }.
function pacificDate(now) {
  const parts = {};
  new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(now || new Date()).forEach((p) => { parts[p.type] = p.value; });
  const year = parseInt(parts.year, 10), month = parseInt(parts.month, 10), day = parseInt(parts.day, 10);
  return { year, month, day, ym: `${year}-${String(month).padStart(2, "0")}` };
}

module.exports = { sign, verify, signUndo, verifyUndo, addUrl, pacificDate };
