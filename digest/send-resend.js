/*
 * Honsama Shelf Digest — Resend sender
 * ------------------------------------
 * Reads digest/digests.json (from generate.js), renders email-template.html
 * for each subscriber and sends the finished HTML through the Resend API from
 * the mail.honsama.com subdomain. Replaces send-klaviyo.js (kept, dormant).
 *
 * DRY RUN by default — prints what it would send and writes three rendered
 * samples to digest/samples/ for eyeballing. Nothing leaves the machine.
 *
 *   node digest/send-resend.js                       # dry run + samples
 *   node digest/send-resend.js --send                # send up to 100 (Resend free daily cap)
 *   node digest/send-resend.js --send --limit 50     # smaller batch
 *   node digest/send-resend.js --only me@x.com       # self-send / canary (comma-separate for several)
 *   node digest/send-resend.js --only a@x.com --to me@y.com --send   # TEST COPY of a's digest to me (send log untouched)
 *   node digest/send-resend.js --reset-state         # forget what was sent for this digests.json
 *
 * Resumable: digest/send-state.json remembers which emails were sent for the
 * CURRENT digests.json (keyed by its hash). Re-running --send on the 17th picks
 * up where the 16th stopped; a new digests.json (next month) starts fresh.
 * Failures are recorded but retried on the next run.
 *
 * Env (.env in repo root — never committed):
 *   RESEND_API_KEY          re_... (Resend → API Keys → Sending access)
 *   DIGEST_UNSUB_SECRET     random string; MUST equal the Vercel env var of the
 *                           same name (the box app verifies the link with it)
 *   DIGEST_POSTAL_ADDRESS   physical mailing address printed in the footer (CAN-SPAM)
 * Optional:
 *   DIGEST_FROM             default: Ricky at Honsama <ricky@mail.honsama.com>
 *   DIGEST_REPLY_TO         default: support@honsama.com
 *   DIGEST_UNSUB_BASE       default: https://app.honsama.com (CNAME -> Vercel; the vercel.app host still works)
 *   DIGEST_SUBJECT          default: Your shelf grew this month, {{first_name}} 📚
 *                           (only for digests with no new-release card; the rest get
 *                           the countdown subject below)
 *   DIGEST_ONE_TAP          1 = new-release and catch-up buttons carry the signed
 *                           one-tap add link (/api/digest/add, digest/add-token.js);
 *                           anything else = they link to the product page as in run 1.
 *                           THE FLAG IS THE ROLLBACK: set it to 0 and the send is run 1's.
 *
 * Subject / preview (2026-10-25, one-tap spec §11 — ported from the volume alert's
 * _single_copy / _multi_copy): tiers by real days to the 21st (Pacific) at send
 * time — 0 · 1 · ≤3 · >3. One new release names it; several give the count. The
 * title is trimmed, never the deadline clause.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const axios = require("axios");
const unsub = require("./unsub-token");
const addToken = require("./add-token");

try {
  fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8").split("\n").forEach((line) => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  });
} catch (e) { /* no .env */ }

// ---- flags ----------------------------------------------------------------
const argv = process.argv.slice(2);
const SEND = argv.includes("--send");
const RESET = argv.includes("--reset-state");
const flagValue = (name) => { const i = argv.indexOf(name); return i !== -1 ? argv[i + 1] : undefined; };
const LIMIT = parseInt(flagValue("--limit") || "100", 10);
const ONLY = (flagValue("--only") || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
// --to a@b.com: deliver the selected digest(s) to this address INSTEAD of the
// customer (test copies for inbox-placement checks). Never touches the send log.
const TO = (flagValue("--to") || "").trim().toLowerCase();

// ---- config ---------------------------------------------------------------
const CFG = {
  apiKey: process.env.RESEND_API_KEY,
  unsubSecret: process.env.DIGEST_UNSUB_SECRET,
  postal: process.env.DIGEST_POSTAL_ADDRESS,
  from: process.env.DIGEST_FROM || "Ricky at Honsama <ricky@mail.honsama.com>",
  replyTo: process.env.DIGEST_REPLY_TO || "support@honsama.com",
  unsubBase: process.env.DIGEST_UNSUB_BASE || "https://app.honsama.com",
  subject: process.env.DIGEST_SUBJECT || "Your shelf grew this month, {{first_name}} 📚",
  oneTap: process.env.DIGEST_ONE_TAP === "1",
};

const DIGESTS_PATH = path.join(__dirname, "digests.json");
const STATE_PATH = path.join(__dirname, "send-state.json");
const TEMPLATE_PATH = path.join(__dirname, "email-template.html");
const SAMPLES_DIR = path.join(__dirname, "samples");
const SEND_SPACING_MS = 600; // Resend free tier: 2 requests/second

// ---- tiny template renderer ----------------------------------------------
// Supports exactly what email-template.html uses:
//   {{ a.b.c }}   {{ a.b|default:'text' }}
//   {% if a.b %} ... {% else %} ... {% endif %}
//   {% for x in a.b %} ... {% endfor %}
// Values are HTML-escaped. `{{ x|safe }}` skips escaping (not used today).
function escapeHtml(v) {
  return String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function lookup(scope, dotted) {
  const parts = dotted.split(".");
  for (let i = scope.length - 1; i >= 0; i--) {
    if (!(parts[0] in scope[i])) continue;
    let v = scope[i];
    for (const p of parts) { if (v == null) return undefined; v = v[p]; }
    return v;
  }
  return undefined;
}

function parseTemplate(src) {
  const tokens = src.split(/(\{%[\s\S]*?%\}|\{\{[\s\S]*?\}\})/);
  let i = 0;
  function block(stopAt) {
    const nodes = [];
    while (i < tokens.length) {
      const t = tokens[i++];
      if (t === undefined || t === "") continue;
      if (t.startsWith("{{")) { nodes.push({ type: "var", expr: t.slice(2, -2).trim() }); continue; }
      if (t.startsWith("{%")) {
        const tag = t.slice(2, -2).trim();
        const kw = tag.split(/\s+/)[0];
        if (stopAt && stopAt.includes(kw)) { i--; return nodes; }
        if (kw === "if") {
          const node = { type: "if", expr: tag.slice(2).trim(), then: block(["else", "endif"]), else: [] };
          const next = tokens[i++].slice(2, -2).trim();
          if (next === "else") { node.else = block(["endif"]); i++; }
          nodes.push(node); continue;
        }
        if (kw === "for") {
          const m = tag.match(/^for\s+(\w+)\s+in\s+([\w.]+)$/);
          if (!m) throw new Error("bad for tag: " + tag);
          const node = { type: "for", item: m[1], expr: m[2], body: block(["endfor"]) };
          i++; nodes.push(node); continue;
        }
        throw new Error("unknown template tag: " + tag);
      }
      nodes.push({ type: "text", text: t });
    }
    return nodes;
  }
  return block(null);
}

function renderNodes(nodes, scope) {
  let out = "";
  for (const n of nodes) {
    if (n.type === "text") out += n.text;
    else if (n.type === "var") {
      const [pathPart, ...filters] = n.expr.split("|").map((s) => s.trim());
      let v = lookup(scope, pathPart);
      let safe = false;
      for (const f of filters) {
        const d = f.match(/^default:\s*'([^']*)'$|^default:\s*"([^"]*)"$/);
        if (d && (v === undefined || v === null || v === "")) v = d[1] !== undefined ? d[1] : d[2];
        if (f === "safe") safe = true;
      }
      if (v === undefined || v === null) v = "";
      out += safe ? String(v) : escapeHtml(v);
    } else if (n.type === "if") {
      const v = lookup(scope, n.expr);
      const truthy = Array.isArray(v) ? v.length > 0 : !!v;
      out += renderNodes(truthy ? n.then : n.else, scope);
    } else if (n.type === "for") {
      const arr = lookup(scope, n.expr) || [];
      for (const item of arr) out += renderNodes(n.body, scope.concat([{ [n.item]: item }]));
    }
  }
  return out;
}

// ---- countdown to the 21st (subject, preview, banner) ----------------------
// Port of honsama_automation\volume_alert\alert_email_generator.py. Days are
// counted in Pacific time, the clock the 20th 11:59 PM PT cutoff runs on.
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const SUBJECT_MAX = 60;   // ~60 chars of subject show in most inboxes
const PREVIEW_MAX = 90;   // preview text gets ~90 chars before truncation

function countdown(now) {
  const pd = addToken.pacificDate(now);
  let y = pd.year, m = pd.month;
  if (pd.day > 21) { m += 1; if (m > 12) { m = 1; y += 1; } }   // past it: next month's 21st
  const days = Math.round((Date.UTC(y, m - 1, 21) - Date.UTC(pd.year, pd.month - 1, pd.day)) / 864e5);
  return { days, deadline: `${MONTHS[m - 1]} 21st`, month: pd.ym };
}

// Trim to limit at a word boundary, adding an ellipsis.
function shorten(text, limit) {
  text = String(text || "");
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit - 1);
  const sp = cut.lastIndexOf(" ");
  return (sp > 0 ? cut.slice(0, sp) : cut) + "…";
}

function singleCopy(title, days, deadline) {
  let suffix, preview;
  if (days === 0) { suffix = " — today's the last day"; preview = "Your add-on window closes today — last call, honestly."; }
  else if (days === 1) { suffix = " — window closes tomorrow"; preview = "Tomorrow is the last day to add this to your box — we didn't want you to miss it."; }
  else if (days <= 3) { suffix = ` — ${days} days left to add it`; preview = `Only ${days} days left in your add-on window — after ${deadline}, it waits until next month.`; }
  else { suffix = " just dropped"; preview = `It's in your add-on window until ${deadline} — we only order copies that get claimed.`; }
  // Shorten the title, not the sentence — "…Vol. 14 just dropped" beats a chopped title
  return { subject: shorten(title, SUBJECT_MAX - suffix.length) + suffix, preview };
}

function multiCopy(count, firstTitle, days, deadline) {
  let subject, tail;
  if (days === 0) { subject = `Last day: ${count} new volumes for your series`; tail = "— your add-on window closes today."; }
  else if (days === 1) { subject = `${count} new volumes — window closes tomorrow`; tail = "— tomorrow is the last day to add them."; }
  else if (days <= 3) { subject = `${count} new volumes — ${days} days left to add them`; tail = `— only ${days} days left before the window closes.`; }
  else { subject = `${count} new volumes for your series just dropped`; tail = `— in your add-on window until ${deadline}.`; }
  // Shorten the title so the urgency tail always survives truncation
  const more = ` + ${count - 1} more `;
  return { subject, preview: `${shorten(firstTitle, PREVIEW_MAX - more.length - tail.length)}${more}${tail}` };
}

// The red banner above the new-release cards. HTML on purpose (rendered |safe):
// every piece is a number or a month name, nothing from the customer.
function bannerHtml(days, deadline) {
  if (days === 0) return "⚠️ Today is the last day to add these to your box.";
  if (days === 1) return "⏰ <strong>1 day left</strong> — add-on window closes tomorrow.";
  if (days <= 3) return `⏰ Only <strong>${days} days left</strong> to add these to your box before ${deadline}.`;
  return `Your add-on window closes <strong>${deadline}</strong> — don't miss it.`;
}

// DIGEST_NOW (ISO date) pins the clock for a dry run, e.g. to see the Nov 16
// tiers today. Never set it for --send.
const CLOCK = countdown(process.env.DIGEST_NOW ? new Date(process.env.DIGEST_NOW) : new Date());

function copyFor(digest) {
  const items = digest.new_releases || [];
  if (!items.length) return { subject: CFG.subject.replace(/\{\{\s*first_name\s*\}\}/g, digest.first_name || "reader"), preview: "" };
  const first = items[0].title || `${items[0].series} Vol. ${items[0].volume}`;
  return items.length === 1 ? singleCopy(first, CLOCK.days, CLOCK.deadline) : multiCopy(items.length, first, CLOCK.days, CLOCK.deadline);
}

// The one-tap link for a card, or null (flag off, secret missing, or the card's
// digests.json row predates variant ids) — the card then links to the product page.
function oneTapUrl(digest, variantId, handle) {
  if (!CFG.oneTap || !CFG.unsubSecret || !/^\d+$/.test(String(variantId || "")) || !handle) return null;
  return addToken.addUrl(CFG.unsubBase, digest.customer_id, variantId, handle, CLOCK.month, CFG.unsubSecret);
}

const TEMPLATE = parseTemplate(fs.readFileSync(TEMPLATE_PATH, "utf8"));
function renderEmail(digest, unsubscribeUrl) {
  const stats = digest.stats || {};
  const ctx = {
    first_name: digest.first_name || "",
    preview: copyFor(digest).preview,
    banner_html: bannerHtml(CLOCK.days, CLOCK.deadline),
    deadline: CLOCK.deadline,
    new_releases: (digest.new_releases || []).map((item) => Object.assign({}, item, {
      add_url: oneTapUrl(digest, item.variant_id, item.handle) || item.url,
      price_label: Number(item.price) > 0 ? `$${Number(item.price).toFixed(2)}` : "",
    })),
    behind: (digest.behind || []).map((s) => Object.assign({}, s, {
      next_add_url: s.next_volume ? oneTapUrl(digest, s.next_variant_id, s.next_handle) : null,
      them: Number(s.behind) === 1 ? "it" : "them",
    })),
    stats,
    volumes_label: Number(stats.volumes) === 1 ? "volume collected" : "volumes collected",
    unsubscribe_url: unsubscribeUrl,
    postal_address: CFG.postal || "",
  };
  return renderNodes(TEMPLATE, [ctx]);
}
function renderSubject(digest) {
  return copyFor(digest).subject;
}

// ---- state ----------------------------------------------------------------
function loadState(digestHash) {
  let state = null;
  try { state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8")); } catch (e) { /* none */ }
  if (RESET || !state || state.digest_hash !== digestHash) {
    if (state && state.digest_hash !== digestHash && !RESET) console.log("digests.json changed since the last run — starting a fresh send log.");
    state = { digest_hash: digestHash, started: new Date().toISOString(), sent: {}, failed: {} };
  }
  return state;
}
function saveState(state) { fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 1)); }

// ---- Resend ---------------------------------------------------------------
async function sendOne(digest, html, unsubscribeUrl, tag, recipient) {
  const body = {
    from: CFG.from,
    to: [recipient || digest.email],
    reply_to: CFG.replyTo,
    subject: renderSubject(digest),
    html,
    headers: {
      "List-Unsubscribe": `<${unsubscribeUrl}>, <mailto:${CFG.replyTo}?subject=unsubscribe>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
    tags: [{ name: "campaign", value: "shelf-digest" }, { name: "run", value: tag }],
  };
  const res = await axios.post("https://api.resend.com/emails", body, {
    headers: { Authorization: `Bearer ${CFG.apiKey}`, "Content-Type": "application/json" },
    timeout: 20000,
  });
  return res.data && res.data.id;
}

// ---- main -----------------------------------------------------------------
async function main() {
  if (!fs.existsSync(DIGESTS_PATH)) { console.error("digest/digests.json not found — run `node digest/generate.js` first."); process.exit(1); }
  const raw = fs.readFileSync(DIGESTS_PATH, "utf8");
  const digestHash = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
  let digests = JSON.parse(raw);
  const runTag = new Date().toISOString().slice(0, 7); // YYYY-MM

  console.log(`${digests.length} digests loaded (digests.json ${digestHash}). Mode: ${SEND ? "SEND" : "dry run"}${ONLY.length ? ` · only ${ONLY.join(", ")}` : ""} · limit ${LIMIT}`);

  // Preflight — every line must read OK before --send is allowed.
  const checks = [
    ["RESEND_API_KEY", !!CFG.apiKey, "Resend → API Keys → create (Sending access) → .env"],
    ["DIGEST_UNSUB_SECRET", !!CFG.unsubSecret, "random string, same value in .env and on Vercel"],
    ["DIGEST_POSTAL_ADDRESS", !!CFG.postal, "physical mailing address for the footer (CAN-SPAM)"],
    ["From uses mail.honsama.com", /@mail\.honsama\.com>?$/.test(CFG.from), `From is "${CFG.from}" — the rule says subdomain only`],
    ["customer_id on every digest", digests.every((d) => /^\d+$/.test(String(d.customer_id || ""))), "re-run generate.js (older digests.json lacks customer_id)"],
    ["DIGEST_NOW not set (--send runs on the real clock)", !(SEND && process.env.DIGEST_NOW), "DIGEST_NOW is for dry runs only — unset it before --send"],
  ];
  // One-tap: only checked when the flag is on. A card without a variant id would
  // quietly fall back to the product page, so --send refuses instead.
  console.log(`  DIGEST_ONE_TAP ${CFG.oneTap ? "on  — cards carry the signed one-tap add link" : "off — cards link to the product page (run 1 behaviour)"}`);
  if (CFG.oneTap) {
    checks.push(["variant_id + handle on every new-release card (one-tap)",
      digests.every((d) => (d.new_releases || []).every((r) => /^\d+$/.test(String(r.variant_id || "")) && r.handle)),
      "re-run generate.js (this digests.json predates one-tap) or set DIGEST_ONE_TAP=0"]);
  }
  console.log(`  countdown: ${CLOCK.days} day(s) to ${CLOCK.deadline} (Pacific${process.env.DIGEST_NOW ? `, pinned by DIGEST_NOW=${process.env.DIGEST_NOW}` : ""}) · one-tap links signed for ${CLOCK.month}`);
  let ok = true;
  for (const [name, pass, hint] of checks) { console.log(`  ${pass ? "OK     " : "MISSING"} ${name}${pass ? "" : " — " + hint}`); if (!pass) ok = false; }

  if (ONLY.length) digests = digests.filter((d) => ONLY.includes(String(d.email).toLowerCase()));
  if (ONLY.length && !digests.length) { console.error("--only matched nobody in digests.json."); process.exit(1); }

  const withNew = digests.filter((d) => d.new_releases.length).length;
  console.log(`  ${digests.length} to consider · ${withNew} have new releases · ${digests.length - withNew} catch-up/stats only`);

  const state = loadState(digestHash);
  const alreadySent = digests.filter((d) => state.sent[d.email]).length;
  if (alreadySent) console.log(`  ${alreadySent} already sent for this digests.json (skipped) · ${digests.length - alreadySent} remaining`);

  if (!SEND) {
    fs.mkdirSync(SAMPLES_DIR, { recursive: true });
    const samples = digests.slice(0, 3);
    samples.forEach((d, idx) => {
      const url = CFG.unsubSecret ? unsub.unsubscribeUrl(CFG.unsubBase, d.customer_id, CFG.unsubSecret) : `${CFG.unsubBase}/api/digest/unsubscribe?c=${d.customer_id}&t=UNSIGNED-SET-DIGEST_UNSUB_SECRET`;
      const file = path.join(SAMPLES_DIR, `sample-${idx + 1}.html`);
      const c = copyFor(d);
      fs.writeFileSync(file, renderEmail(d, url) + `\n<!-- sample for: ${d.email} · subject: ${c.subject} · preview: ${c.preview} -->\n`);
    });
    digests.forEach((d) => console.log(`DRY  ${d.email}: ${d.new_releases.length} new, ${d.behind.length} catch-up, ${d.stats.volumes} vols (${d.stats.from_boxes} from boxes) · "${renderSubject(d)}"${state.sent[d.email] ? "  [already sent]" : ""}`));
    console.log(`\nDry run only. ${samples.length} rendered sample(s) in digest/samples/ — open them in a browser.`);
    if (!ok) console.log("Fix the MISSING lines above before --send.");
    return;
  }

  if (!ok) { console.error("\nRefusing to send: fix the MISSING lines above."); process.exit(1); }

  if (TO) console.log(`TEST COPY mode: delivering to ${TO} instead of the customer; the send log is not updated.`);
  let sent = 0, failed = 0, skipped = 0;
  for (const d of digests) {
    if (!TO && state.sent[d.email]) { skipped++; continue; }
    if (sent >= LIMIT) { console.log(`Limit ${LIMIT} reached — re-run tomorrow for the rest.`); break; }
    const summary = `${d.email}${TO ? ` -> ${TO}` : ""}: ${d.new_releases.length} new, ${d.behind.length} catch-up`;
    try {
      const url = unsub.unsubscribeUrl(CFG.unsubBase, d.customer_id, CFG.unsubSecret);
      const id = await sendOne(d, renderEmail(d, url), url, runTag, TO);
      if (!TO) { state.sent[d.email] = { id, at: new Date().toISOString() }; delete state.failed[d.email]; }
      sent++;
      console.log(`SENT ${summary} (${id})`);
    } catch (e) {
      const status = e.response && e.response.status;
      const detail = e.response && e.response.data ? JSON.stringify(e.response.data) : e.message;
      if (!TO) state.failed[d.email] = { error: detail, at: new Date().toISOString() };
      failed++;
      console.error(`FAIL ${summary}: ${status || ""} ${detail}`);
      if (!TO) saveState(state);
      if (status === 429 && /daily|quota/i.test(detail)) { console.error("Daily quota hit — stop here, re-run tomorrow."); break; }
      if (status === 401 || status === 403) { console.error("Resend rejected the API key — stopping."); break; }
    }
    saveState(state);
    await new Promise((r) => setTimeout(r, SEND_SPACING_MS));
  }
  saveState(state);
  const remaining = digests.filter((d) => !state.sent[d.email]).length;
  console.log(`\nDone: ${sent} sent, ${failed} failed, ${skipped} already sent earlier. ${remaining} remaining for this digests.json.`);
  console.log("Log: digest/send-state.json · Resend dashboard for bounces/complaints (>2% = stop and read).");
}

main().catch((e) => { console.error(e.message); process.exit(1); });
