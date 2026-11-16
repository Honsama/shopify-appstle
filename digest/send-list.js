/*
 * List sender — one short email to a tagged list, on the Shelf Digest's Resend lane
 * (HonsamaOps brief 2, B2-c; built 2026-11-16)
 * -------------------------------------------------------------------------
 * For the small monthly sends that used to be pasted into Shopify Email by hand:
 * the pre-21st hype note (tag honsama_hype_YYYY_MM) and the skip-month nudge
 * (the tag skip_nudge.py writes). Same sender, unsubscribe link and consent rule
 * as the digest; nothing in the digest's own run changes.
 *
 * DRY RUN by default: prints who would get it and writes one rendered sample to
 * digest/samples/list-<campaign>.html. Nothing leaves the machine.
 *
 *   node digest/send-list.js --tag honsama_hype_2026_11 --html path/to/2026-11.shopify.html \
 *        --subject "{{first_name}}, December's box locks on the 21st" --campaign hype-2026-11
 *   ... --send                       send
 *   ... --only me@x.com --send       canary / self-send (must be on the list)
 *   ... --only a@x.com --to me@y.com --send    TEST COPY of a's email to me (log untouched)
 *   ... --allow-paused               also send to paused subscribers (skip nudge only)
 *
 * Who gets it: customers carrying --tag, with Shopify marketing consent
 * SUBSCRIBED, and the Appstle active tag (or the paused tag with --allow-paused).
 * Everyone else on the tag is listed as skipped, with the reason. Cancelled
 * subscribers never get it.
 *
 * Once per campaign: digest/list-state.json records every send by campaign and
 * customer id, so a re-run sends only to people it has not reached yet.
 *
 * The HTML file may be a Shopify Email paste. These tokens are filled in:
 *   {{ customer.first_name | default: "there" }} / {{first_name}}   first name, or the default
 *   {{ unsubscribe_link }} / {{unsubscribe_url}}                    the signed digest unsubscribe link
 *   {{ open_tracking_block }}                                       removed
 * A file with no unsubscribe token gets a plain footer line with the link and the
 * postal address, because a marketing email must carry both.
 *
 * Env (.env in the repo root, the digest's): RESEND_API_KEY, DIGEST_UNSUB_SECRET,
 * DIGEST_POSTAL_ADDRESS, DIGEST_FROM / DIGEST_REPLY_TO / DIGEST_UNSUB_BASE.
 * Resend's free plan allows 100 emails a day across every sender on the account.
 */

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const S = require("./send-resend");   // CFG, escapeHtml
const G = require("./generate");      // adminGraphql, resolveAdminToken
const unsub = require("./unsub-token");

const argv = process.argv.slice(2);
const SEND = argv.includes("--send");
const ALLOW_PAUSED = argv.includes("--allow-paused");
const flagValue = (name) => { const i = argv.indexOf(name); return i !== -1 ? argv[i + 1] : undefined; };
const TAG = (flagValue("--tag") || "").trim();
const HTML_PATH = flagValue("--html");
const SUBJECT = flagValue("--subject") || "";
const CAMPAIGN = (flagValue("--campaign") || TAG).replace(/[^A-Za-z0-9_-]/g, "-");
const LIMIT = parseInt(flagValue("--limit") || "100", 10);
const ONLY = (flagValue("--only") || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const TO = (flagValue("--to") || "").trim().toLowerCase();

const CFG = S.CFG;
const STATE_PATH = path.join(__dirname, "list-state.json");
const SAMPLES_DIR = path.join(__dirname, "samples");
const SEND_SPACING_MS = 600;
const ACTIVE_TAG = "appstle_subscription_active_customer";
const PAUSED_TAG = "appstle_subscription_paused_customer";

// ---- rendering --------------------------------------------------------------
const FIRST_NAME_RE = /\{\{\s*(?:customer\.)?first_name\s*(?:\|\s*default:\s*(["'])(.*?)\1\s*)?\}\}/g;
const UNSUB_RE = /\{\{\s*unsubscribe_(?:link|url)\s*\}\}/g;
const UNSUB_IN_HREF_RE = /(href\s*=\s*["'])\s*\{\{\s*unsubscribe_(?:link|url)\s*\}\}\s*(["'])/g;

function fillName(text, firstName, escape) {
  return text.replace(FIRST_NAME_RE, (_m, _q, dflt) => {
    const v = (firstName || "").trim() || dflt || "there";
    return escape ? S.escapeHtml(v) : v;
  });
}

function render(template, c, unsubscribeUrl) {
  let html = fillName(template, c.firstName, true).replace(/\{\{\s*open_tracking_block\s*\}\}/g, "");
  const hadToken = UNSUB_RE.test(html);
  UNSUB_RE.lastIndex = 0;
  html = html.replace(UNSUB_IN_HREF_RE, `$1${unsubscribeUrl}$2`);
  html = html.replace(UNSUB_RE, `<a href="${unsubscribeUrl}" style="color:#888888;">Unsubscribe</a>`);
  if (!hadToken) {
    html += `\n<p style="font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:#888888;text-align:center;padding:16px 12px;">` +
      `${S.escapeHtml(CFG.postal || "")}<br><a href="${unsubscribeUrl}" style="color:#888888;">Unsubscribe</a></p>`;
  } else if (CFG.postal && !html.includes(CFG.postal)) {
    html += `\n<p style="font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:#888888;text-align:center;padding:0 12px 16px;">${S.escapeHtml(CFG.postal)}</p>`;
  }
  const leftover = html.match(/\{\{[^}]*\}\}|\{%[^%]*%\}/g);
  return { html, leftover: leftover || [] };
}

// ---- the list ---------------------------------------------------------------
async function fetchTagged(tag) {
  const out = [];
  let after = null;
  for (let page = 0; page < 20; page++) {
    const data = await G.adminGraphql(
      `query Tagged($q: String!, $after: String) {
        customers(first: 100, query: $q, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes { id email firstName tags emailMarketingConsent { marketingState } }
        }
      }`,
      { q: `tag:'${tag}'`, after }
    );
    data.customers.nodes.forEach((c) => {
      // the search is fuzzy on tags: keep exact matches only
      if (!(c.tags || []).includes(tag)) return;
      out.push({
        id: String(c.id).split("/").pop(), email: c.email || "", firstName: c.firstName || "",
        tags: c.tags || [], consent: c.emailMarketingConsent?.marketingState || "UNKNOWN",
      });
    });
    if (!data.customers.pageInfo.hasNextPage) break;
    after = data.customers.pageInfo.endCursor;
  }
  return out;
}

function whySkipped(c) {
  if (!c.email) return "no email";
  if (c.consent !== "SUBSCRIBED") return `consent ${c.consent}`;
  if (c.tags.includes(ACTIVE_TAG)) return null;
  if (ALLOW_PAUSED && c.tags.includes(PAUSED_TAG)) return null;
  return c.tags.includes(PAUSED_TAG) ? "paused (pass --allow-paused to include)" : "not an active subscriber";
}

// ---- state ------------------------------------------------------------------
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")); } catch (e) { return {}; } }
function saveState(state) { fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 1)); }

// ---- Resend -----------------------------------------------------------------
async function sendOne(c, subject, html, unsubscribeUrl, runTag, recipient) {
  const res = await axios.post("https://api.resend.com/emails", {
    from: CFG.from,
    to: [recipient || c.email],
    reply_to: CFG.replyTo,
    subject,
    html,
    headers: {
      "List-Unsubscribe": `<${unsubscribeUrl}>, <mailto:${CFG.replyTo}?subject=unsubscribe>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
    tags: [{ name: "campaign", value: CAMPAIGN }, { name: "run", value: runTag }],
  }, { headers: { Authorization: `Bearer ${CFG.apiKey}`, "Content-Type": "application/json" }, timeout: 20000 });
  return res.data && res.data.id;
}

// ---- main -------------------------------------------------------------------
async function main() {
  if (!TAG || !HTML_PATH || !SUBJECT) {
    console.error('Usage: node digest/send-list.js --tag <customer tag> --html <file> --subject "<subject>" [--campaign name] [--allow-paused] [--only a@x.com] [--to me@y.com] [--send]');
    process.exit(1);
  }
  if (!fs.existsSync(HTML_PATH)) { console.error(`HTML file not found: ${HTML_PATH}`); process.exit(1); }
  const template = fs.readFileSync(HTML_PATH, "utf8");

  const tokenSource = await G.resolveAdminToken();
  if (!tokenSource) { console.error("No Admin API access: cannot read the tagged list."); process.exit(1); }

  const tagged = await fetchTagged(TAG);
  const skipped = tagged.map((c) => ({ c, why: whySkipped(c) })).filter((x) => x.why);
  let list = tagged.filter((c) => !whySkipped(c));
  console.log(`Tag ${TAG}: ${tagged.length} customer(s), ${list.length} can be emailed, ${skipped.length} skipped. Mode: ${SEND ? "SEND" : "dry run"} · campaign ${CAMPAIGN}${ALLOW_PAUSED ? " · paused allowed" : ""}`);
  const reasons = {};
  skipped.forEach((x) => { reasons[x.why] = (reasons[x.why] || 0) + 1; });
  Object.keys(reasons).forEach((w) => console.log(`  skipped ${reasons[w]}: ${w}`));

  if (ONLY.length) list = list.filter((c) => ONLY.includes(c.email.toLowerCase()));
  if (ONLY.length && !list.length) { console.error("--only matched nobody who can be emailed on this tag."); process.exit(1); }

  const sample = list[0] || { id: "0", firstName: "", email: "nobody@example.com" };
  const sampleUrl = CFG.unsubSecret ? unsub.unsubscribeUrl(CFG.unsubBase, sample.id, CFG.unsubSecret) : `${CFG.unsubBase}/api/digest/unsubscribe?c=${sample.id}&t=UNSIGNED`;
  const rendered = render(template, sample, sampleUrl);

  const checks = [
    ["RESEND_API_KEY", !!CFG.apiKey, "Resend → API Keys → Sending access"],
    ["DIGEST_UNSUB_SECRET", !!CFG.unsubSecret, "same value in .env and on Vercel"],
    ["DIGEST_POSTAL_ADDRESS", !!CFG.postal, "physical mailing address for the footer"],
    ["From on the subdomain", /@mail\.honsama\.com>?\s*$/.test(CFG.from), "DIGEST_FROM must be @mail.honsama.com"],
    ["no unfilled {{ }} or {% %} left in the HTML", rendered.leftover.length === 0, `unfilled: ${rendered.leftover.slice(0, 4).join(" ")}`],
    ["subject is 78 characters or fewer", fillName(SUBJECT, "Alexandria", false).length <= 78, "shorten the subject"],
    [`list fits one day (${list.length} of ${LIMIT})`, list.length <= LIMIT, "raise --limit only on a paid Resend plan"],
  ];
  let ok = true;
  checks.forEach(([name, pass, hint]) => { console.log(`  ${pass ? "OK     " : "MISSING"} ${name}${pass ? "" : ` — ${hint}`}`); if (!pass) ok = false; });

  const state = loadState();
  const done = (state[CAMPAIGN] && state[CAMPAIGN].sent) || {};
  const already = list.filter((c) => done[c.id]).length;
  if (already) console.log(`  ${already} of these already got this campaign — they are skipped.`);

  if (!SEND) {
    fs.mkdirSync(SAMPLES_DIR, { recursive: true });
    const file = path.join(SAMPLES_DIR, `list-${CAMPAIGN}.html`);
    fs.writeFileSync(file, rendered.html + `\n<!-- sample · subject: ${fillName(SUBJECT, sample.firstName, false)} -->\n`);
    console.log(`  sample: ${file}`);
    console.log(`\nDry run: ${list.length - already} would go out. Add --send to send.`);
    if (!ok) console.log("Fix the MISSING lines above before --send.");
    return;
  }
  if (!ok) { console.error("\nRefusing to send: fix the MISSING lines above."); process.exit(1); }
  if (TO) console.log(`TEST COPY mode: delivering to ${TO} instead of the customer; the log is not touched.`);

  state[CAMPAIGN] = state[CAMPAIGN] || { tag: TAG, subject: SUBJECT, sent: {}, failed: {} };
  const runTag = new Date().toISOString().slice(0, 10);
  let sent = 0, failed = 0, skippedDone = 0;
  for (const c of list) {
    if (!TO && state[CAMPAIGN].sent[c.id]) { skippedDone++; continue; }
    if (sent >= LIMIT) { console.log(`Limit ${LIMIT} reached — re-run tomorrow for the rest.`); break; }
    try {
      const url = unsub.unsubscribeUrl(CFG.unsubBase, c.id, CFG.unsubSecret);
      const id = await sendOne(c, fillName(SUBJECT, c.firstName, false), render(template, c, url).html, url, runTag, TO);
      if (!TO) {
        // ids only in the log: this file is committed, so no customer emails in it
        state[CAMPAIGN].sent[c.id] = { id, at: new Date().toISOString() };
        delete state[CAMPAIGN].failed[c.id];
        saveState(state);
      }
      sent++;
      console.log(`SENT customer ${c.id}${TO ? ` -> ${TO}` : ""} (${id})`);
    } catch (e) {
      const status = e.response && e.response.status;
      const detail = e.response && e.response.data ? JSON.stringify(e.response.data) : e.message;
      if (!TO) { state[CAMPAIGN].failed[c.id] = { error: detail, at: new Date().toISOString() }; saveState(state); }
      failed++;
      console.error(`FAIL customer ${c.id}: ${status || ""} ${detail}`);
      if (status === 429 && /daily|quota/i.test(detail)) { console.error("Daily quota hit — stop here, re-run tomorrow."); break; }
      if (status === 401 || status === 403) { console.error("Resend rejected the API key — stopping."); break; }
    }
    await new Promise((r) => setTimeout(r, SEND_SPACING_MS));
  }
  console.log(`\nDone: ${sent} sent, ${failed} failed, ${skippedDone} already sent earlier, ${skipped.length} skipped (consent or status).`);
  console.log("Log: digest/list-state.json · Resend dashboard for bounces/complaints (>2% = stop and read).");
  if (failed) process.exitCode = 2;
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { render, fillName, whySkipped };
