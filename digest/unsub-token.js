/*
 * Shelf Digest — unsubscribe link signing (shared by send-resend.js and the
 * box app's /api/digest/unsubscribe route in ../index.js).
 *
 * token = HMAC-SHA256(DIGEST_UNSUB_SECRET, "digest-unsubscribe:<customerId>")
 * No expiry on purpose: an unsubscribe link in a sent email has to keep
 * working (CAN-SPAM says at least 30 days; we just never break it).
 * The secret is a random string that lives in BOTH shopify-appstle/.env (the
 * machine that sends) and the Vercel project env (the machine that verifies).
 */
const crypto = require("crypto");

function sign(customerId, secret) {
  if (!secret) throw new Error("DIGEST_UNSUB_SECRET is not set");
  return crypto.createHmac("sha256", secret).update(`digest-unsubscribe:${String(customerId)}`).digest("hex");
}

function verify(customerId, token, secret) {
  if (!secret || !/^\d+$/.test(String(customerId || "")) || !/^[0-9a-f]{64}$/.test(String(token || ""))) return false;
  const expected = Buffer.from(sign(customerId, secret));
  const given = Buffer.from(String(token));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

function unsubscribeUrl(base, customerId, secret) {
  return `${String(base).replace(/\/+$/, "")}/api/digest/unsubscribe?c=${encodeURIComponent(customerId)}&t=${sign(customerId, secret)}`;
}

module.exports = { sign, verify, unsubscribeUrl };
