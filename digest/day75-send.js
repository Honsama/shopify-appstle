/*
 * Day-75 continuation touch — Resend sender (churn plan #16, built 2026-10-27)
 * -------------------------------------------------------------------------
 * Reads digest/day75.json (from day75-generate.js), renders day75-template.html
 * per subscriber and sends it through Resend from mail.honsama.com — the
 * Shelf Digest's lane (send-resend.js lends the renderer, the countdown clock
 * and the config; nothing in the digest's own run changes).
 *
 * DRY RUN by default — prints what it would send and writes up to three
 * rendered samples to digest/samples/day75-N.html. Nothing leaves the machine.
 *
 *   node digest/day75-send.js                          # dry run + samples
 *   node digest/day75-send.js --send                   # send (counts against Resend's 100/day with the digest)
 *   node digest/day75-send.js --only me@x.com          # self-send / canary (comma-separate for several)
 *   node digest/day75-send.js --only a@x.com --to me@y.com --send   # TEST COPY of a's email to me (log untouched)
 *   node digest/day75-send.js --forget a@x.com         # drop one address from the lifetime log (re-send tests)
 *
 * ONCE IN A LIFETIME: digest/day75-state.json is the permanent record of who
 * got this email (keyed by customer id, never reset by a new day75.json), and
 * every successful send also tags the customer honsama_day75_YYYY_MM (best
 * effort — the Analyst's cohort readout keys on it; the state file is the
 * guard even when the tag write fails). day75-generate.js skips both.
 *
 * Env: the digest's (.env in the repo root): RESEND_API_KEY, DIGEST_UNSUB_SECRET,
 * DIGEST_POSTAL_ADDRESS, DIGEST_FROM/REPLY_TO/UNSUB_BASE, DIGEST_ONE_TAP (1 =
 * the buttons carry the signed one-tap add link; else the product page — the
 * same rollback flag as the digest), DIGEST_NOW (dry runs only).
 */

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const S = require("./send-resend");       // CFG, parseTemplate, renderNodes, CLOCK, bannerHtml, shorten
const G = require("./generate");          // adminGraphql + resolveAdminToken, for the cohort tag
const unsub = require("./unsub-token");
const addToken = require("./add-token");

const argv = process.argv.slice(2);
const SEND = argv.includes("--send");
const flagValue = (name) => { const i = argv.indexOf(name); return i !== -1 ? argv[i + 1] : undefined; };
const LIMIT = parseInt(flagValue("--limit") || "100", 10);
const ONLY = (flagValue("--only") || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const TO = (flagValue("--to") || "").trim().toLowerCase();
const FORGET = (flagValue("--forget") || "").trim().toLowerCase();

const CFG = S.CFG;
const CLOCK = S.CLOCK;
const DATA_PATH = path.join(__dirname, "day75.json");
const STATE_PATH = path.join(__dirname, "day75-state.json");
const TEMPLATE_PATH = path.join(__dirname, "day75-template.html");
const SAMPLES_DIR = path.join(__dirname, "samples");
const SEND_SPACING_MS = 600;
const CAMPAIGN = "day75-continuation";
const COHORT_TAG = `honsama_day75_${CLOCK.month.replace("-", "_")}`;

// ---- copy -----------------------------------------------------------------
const SUBJECT_MAX = 60;
function copyFor(d) {
  const n = d.series.length;
  const first = d.series[0];
  if (n === 1) {
    const suffix = " is here — 15% off";
    return {
      subject: S.shorten(`${first.series} Vol. ${first.next_volume}`, SUBJECT_MAX - suffix.length) + suffix,
      preview: `Ships inside your next box, no extra shipping — add it before ${CLOCK.deadline}.`,
    };
  }
  return {
    subject: `You've started ${n} series — the next volumes are here`,
    preview: `15% off for subscribers, shipped inside your next box — add them before ${CLOCK.deadline}.`,
  };
}

function money(p) { const n = Number(p); return Number.isFinite(n) && n > 0 ? `$${n.toFixed(2)}` : ""; }
function pctOff(price, compare) {
  const p = Number(price), c = Number(compare);
  return p > 0 && c > p ? Math.round((1 - p / c) * 100) : 0;
}

function oneTapUrl(d, s) {
  if (!CFG.oneTap || !CFG.unsubSecret || !/^\d+$/.test(String(s.variant_id || "")) || !s.handle) return null;
  return addToken.addUrl(CFG.unsubBase, d.customer_id, s.variant_id, s.handle, CLOCK.month, CFG.unsubSecret);
}

const TEMPLATE = S.parseTemplate(fs.readFileSync(TEMPLATE_PATH, "utf8"));
function renderEmail(d, unsubscribeUrl) {
  const pd = addToken.pacificDate(process.env.DIGEST_NOW ? new Date(process.env.DIGEST_NOW) : new Date());
  const n = d.series.length;
  const ctx = {
    first_name: d.first_name || "",
    preview: copyFor(d).preview,
    boxes: d.boxes,
    boxes_word: Number(d.boxes) === 1 ? "box" : "boxes",
    series_count: n,
    one_series: n === 1,
    several_series: n > 1,
    series: d.series.map((s) => {
      const off = pctOff(s.price, s.compare_at);
      return Object.assign({}, s, {
        add_url: oneTapUrl(d, s) || s.url,
        price_label: money(s.price),
        compare_label: off ? money(s.compare_at) : "",
        off_label: off ? `${off}% off for subscribers` : "subscriber price",
        shelf_line: `You have ${s.owned_count} of ${s.total}` + (s.from_box ? " · it started in your box" : ""),
      });
    }),
    deadline: CLOCK.deadline,
    urgent: CLOCK.days <= 3,
    banner_html: S.bannerHtml(CLOCK.days, CLOCK.deadline),
    vote_open: pd.day <= 14,
    swap_open: pd.day >= 17 && pd.day <= 20,
    stats: d.stats || {},
    unsubscribe_url: unsubscribeUrl,
    postal_address: CFG.postal || "",
  };
  return S.renderNodes(TEMPLATE, [ctx]);
}

// ---- state (lifetime) ----------------------------------------------------
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")); } catch (e) { return { campaign: CAMPAIGN, sent: {}, failed: {} }; }
}
function saveState(state) { fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 1)); }

// ---- Shopify cohort tag (best effort) -------------------------------------
async function tagCustomer(customerId) {
  const data = await G.adminGraphql(
    `mutation Tag($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { field message } } }`,
    { id: `gid://shopify/Customer/${customerId}`, tags: [COHORT_TAG] }
  );
  const errs = data?.tagsAdd?.userErrors || [];
  if (errs.length) throw new Error(errs.map((e) => e.message).join("; "));
}

// ---- Resend ---------------------------------------------------------------
async function sendOne(d, html, unsubscribeUrl, runTag, recipient) {
  const body = {
    from: CFG.from,
    to: [recipient || d.email],
    reply_to: CFG.replyTo,
    subject: copyFor(d).subject,
    html,
    headers: {
      "List-Unsubscribe": `<${unsubscribeUrl}>, <mailto:${CFG.replyTo}?subject=unsubscribe>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
    tags: [{ name: "campaign", value: CAMPAIGN }, { name: "run", value: runTag }],
  };
  const res = await axios.post("https://api.resend.com/emails", body, {
    headers: { Authorization: `Bearer ${CFG.apiKey}`, "Content-Type": "application/json" },
    timeout: 20000,
  });
  return res.data && res.data.id;
}

// ---- main -----------------------------------------------------------------
async function main() {
  const state = loadState();
  if (FORGET) {
    const hits = Object.keys(state.sent).filter((cid) => (state.sent[cid].email || "").toLowerCase() === FORGET);
    hits.forEach((cid) => { delete state.sent[cid]; });
    saveState(state);
    console.log(`${hits.length} entry(ies) for ${FORGET} dropped from the lifetime log. The honsama_day75_* tag on the customer stays — remove it in Shopify too if they must receive the email again.`);
    return;
  }
  if (!fs.existsSync(DATA_PATH)) { console.error("digest/day75.json not found — run `node digest/day75-generate.js` first."); process.exit(1); }
  let list = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
  const runTag = new Date().toISOString().slice(0, 10);
  console.log(`${list.length} Day-75 email(s) loaded. Mode: ${SEND ? "SEND" : "dry run"}${ONLY.length ? ` · only ${ONLY.join(", ")}` : ""} · limit ${LIMIT}`);
  if (ONLY.length) list = list.filter((d) => ONLY.includes(String(d.email).toLowerCase()));
  if (ONLY.length && !list.length) { console.error("--only matched nobody in day75.json."); process.exit(1); }

  // Preflight — the digest's lines, plus the lifetime log.
  const checks = [
    ["RESEND_API_KEY", !!CFG.apiKey, "Resend → API Keys → Sending access"],
    ["DIGEST_UNSUB_SECRET", !!CFG.unsubSecret, "random string, same value in .env and on Vercel"],
    ["DIGEST_POSTAL_ADDRESS", !!CFG.postal, "physical mailing address for the footer (CAN-SPAM)"],
    ["From on the subdomain", /@mail\.honsama\.com>?\s*$/.test(CFG.from), "DIGEST_FROM must be @mail.honsama.com"],
    ["customer_id on every row", list.every((d) => /^\d+$/.test(String(d.customer_id || ""))), "re-run day75-generate.js"],
    ["DIGEST_NOW not set (--send runs on the real clock)", !(SEND && process.env.DIGEST_NOW), "unset DIGEST_NOW before --send"],
  ];
  let ok = true;
  checks.forEach(([name, pass, hint]) => { console.log(`  ${pass ? "OK     " : "MISSING"} ${name}${pass ? "" : ` — ${hint}`}`); if (!pass) ok = false; });
  console.log(`  DIGEST_ONE_TAP ${CFG.oneTap ? "on  — buttons carry the signed one-tap add link" : "off — buttons link to the product page"}`);
  console.log(`  countdown: ${CLOCK.days} day(s) to ${CLOCK.deadline} (Pacific${process.env.DIGEST_NOW ? `, pinned by DIGEST_NOW=${process.env.DIGEST_NOW}` : ""}) · cohort tag ${COHORT_TAG}`);
  const alreadySent = list.filter((d) => state.sent[d.customer_id]).length;
  if (alreadySent) console.log(`  ${alreadySent} of these already got the Day-75 email (lifetime log) — they are skipped.`);

  if (!SEND) {
    fs.mkdirSync(SAMPLES_DIR, { recursive: true });
    list.slice(0, 3).forEach((d, i) => {
      const c = copyFor(d);
      const url = CFG.unsubSecret ? unsub.unsubscribeUrl(CFG.unsubBase, d.customer_id, CFG.unsubSecret) : `${CFG.unsubBase}/api/digest/unsubscribe?c=${d.customer_id}&t=UNSIGNED-SET-DIGEST_UNSUB_SECRET`;
      const file = path.join(SAMPLES_DIR, `day75-${i + 1}.html`);
      fs.writeFileSync(file, renderEmail(d, url) + `\n<!-- sample for: ${d.email} · day ${d.tenure_days} · subject: ${c.subject} · preview: ${c.preview} -->\n`);
      console.log(`  sample ${i + 1}: ${file} · ${d.email} · day ${d.tenure_days} · ${d.series.length} series · subject: ${c.subject}`);
    });
    list.forEach((d) => console.log(`  WOULD SEND day ${String(d.tenure_days).padStart(3)} · ${d.email} · ${d.series.map((s) => `${s.series} Vol. ${s.next_volume}`).join(" · ")}`));
    console.log(`\nDry run: ${list.length - alreadySent} would go out. Add --send to send.`);
    if (!ok) console.log("Fix the MISSING lines above before --send.");
    return;
  }
  if (!ok) { console.error("\nRefusing to send: fix the MISSING lines above."); process.exit(1); }

  const tokenSource = TO ? null : await G.resolveAdminToken();
  if (!TO && !tokenSource) console.log("No Admin API access for the cohort tag — sends go out, the lifetime log is the only guard this run.");
  if (TO) console.log(`TEST COPY mode: delivering to ${TO} instead of the customer; the lifetime log and the tag are not touched.`);

  let sent = 0, failed = 0, skipped = 0;
  for (const d of list) {
    if (!TO && state.sent[d.customer_id]) { skipped++; continue; }
    if (sent >= LIMIT) { console.log(`Limit ${LIMIT} reached — re-run tomorrow for the rest.`); break; }
    const summary = `${d.email}${TO ? ` -> ${TO}` : ""}: day ${d.tenure_days}, ${d.series.length} series`;
    try {
      const url = unsub.unsubscribeUrl(CFG.unsubBase, d.customer_id, CFG.unsubSecret);
      const id = await sendOne(d, renderEmail(d, url), url, runTag, TO);
      if (!TO) {
        state.sent[d.customer_id] = { email: d.email, id, at: new Date().toISOString(), tenure_days: d.tenure_days, series: d.series.map((s) => s.next_sku), tag: null };
        delete state.failed[d.customer_id];
        saveState(state);
        if (tokenSource) {
          try { await tagCustomer(d.customer_id); state.sent[d.customer_id].tag = COHORT_TAG; }
          catch (e) { state.sent[d.customer_id].tag = `FAILED: ${e.message}`; console.error(`  tag failed for ${d.email}: ${e.message}`); }
          saveState(state);
        }
      }
      sent++;
      console.log(`SENT ${summary} (${id})`);
    } catch (e) {
      const status = e.response && e.response.status;
      const detail = e.response && e.response.data ? JSON.stringify(e.response.data) : e.message;
      if (!TO) { state.failed[d.customer_id] = { email: d.email, error: detail, at: new Date().toISOString() }; saveState(state); }
      failed++;
      console.error(`FAIL ${summary}: ${status || ""} ${detail}`);
      if (status === 429 && /daily|quota/i.test(detail)) { console.error("Daily quota hit — stop here, re-run tomorrow."); break; }
      if (status === 401 || status === 403) { console.error("Resend rejected the API key — stopping."); break; }
    }
    await new Promise((r) => setTimeout(r, SEND_SPACING_MS));
  }
  saveState(state);
  const untagged = Object.values(state.sent).filter((s) => s.tag && String(s.tag).startsWith("FAILED")).length;
  console.log(`\nDone: ${sent} sent, ${failed} failed, ${skipped} already sent earlier.${untagged ? ` ${untagged} cohort tag write(s) failed — add ${COHORT_TAG} by hand in Shopify.` : ""}`);
  console.log("Log: digest/day75-state.json (lifetime) · Resend dashboard for bounces/complaints (>2% = stop and read).");
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { copyFor, pctOff };
