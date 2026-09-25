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
 *   DIGEST_UNSUB_BASE       default: https://shopify-appstle.vercel.app
 *   DIGEST_SUBJECT          default: Your shelf grew this month, {{first_name}} 📚
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const axios = require("axios");
const unsub = require("./unsub-token");

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

// ---- config ---------------------------------------------------------------
const CFG = {
  apiKey: process.env.RESEND_API_KEY,
  unsubSecret: process.env.DIGEST_UNSUB_SECRET,
  postal: process.env.DIGEST_POSTAL_ADDRESS,
  from: process.env.DIGEST_FROM || "Ricky at Honsama <ricky@mail.honsama.com>",
  replyTo: process.env.DIGEST_REPLY_TO || "support@honsama.com",
  unsubBase: process.env.DIGEST_UNSUB_BASE || "https://shopify-appstle.vercel.app",
  subject: process.env.DIGEST_SUBJECT || "Your shelf grew this month, {{first_name}} 📚",
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

const TEMPLATE = parseTemplate(fs.readFileSync(TEMPLATE_PATH, "utf8"));
function renderEmail(digest, unsubscribeUrl) {
  const ctx = {
    first_name: digest.first_name || "",
    new_releases: digest.new_releases || [],
    behind: digest.behind || [],
    stats: digest.stats || {},
    unsubscribe_url: unsubscribeUrl,
    postal_address: CFG.postal || "",
  };
  return renderNodes(TEMPLATE, [ctx]);
}
function renderSubject(digest) {
  return CFG.subject.replace(/\{\{\s*first_name\s*\}\}/g, digest.first_name || "reader");
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
async function sendOne(digest, html, unsubscribeUrl, tag) {
  const body = {
    from: CFG.from,
    to: [digest.email],
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
  ];
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
      fs.writeFileSync(file, `<!-- To: ${d.email} · Subject: ${renderSubject(d)} -->\n` + renderEmail(d, url));
    });
    digests.forEach((d) => console.log(`DRY  ${d.email}: ${d.new_releases.length} new, ${d.behind.length} catch-up, ${d.stats.volumes} vols (${d.stats.from_boxes} from boxes)${state.sent[d.email] ? "  [already sent]" : ""}`));
    console.log(`\nDry run only. ${samples.length} rendered sample(s) in digest/samples/ — open them in a browser.`);
    if (!ok) console.log("Fix the MISSING lines above before --send.");
    return;
  }

  if (!ok) { console.error("\nRefusing to send: fix the MISSING lines above."); process.exit(1); }

  let sent = 0, failed = 0, skipped = 0;
  for (const d of digests) {
    if (state.sent[d.email]) { skipped++; continue; }
    if (sent >= LIMIT) { console.log(`Limit ${LIMIT} reached — re-run tomorrow for the rest.`); break; }
    const summary = `${d.email}: ${d.new_releases.length} new, ${d.behind.length} catch-up`;
    try {
      const url = unsub.unsubscribeUrl(CFG.unsubBase, d.customer_id, CFG.unsubSecret);
      const id = await sendOne(d, renderEmail(d, url), url, runTag);
      state.sent[d.email] = { id, at: new Date().toISOString() };
      delete state.failed[d.email];
      sent++;
      console.log(`SENT ${summary} (${id})`);
    } catch (e) {
      const status = e.response && e.response.status;
      const detail = e.response && e.response.data ? JSON.stringify(e.response.data) : e.message;
      state.failed[d.email] = { error: detail, at: new Date().toISOString() };
      failed++;
      console.error(`FAIL ${summary}: ${status || ""} ${detail}`);
      saveState(state);
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
