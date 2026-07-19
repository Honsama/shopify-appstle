/*
 * Honsama Shelf Digest — Klaviyo sender
 * -------------------------------------
 * Reads digest/digests.json (from generate.js) and pushes one "Shelf Digest"
 * event per customer to Klaviyo. A Klaviyo flow triggered on that metric
 * sends the email using the event properties (see email-template.html).
 *
 * DRY RUN by default — prints what it would send. Pass --send to actually
 * push events:
 *   node digest/send-klaviyo.js          # dry run
 *   node digest/send-klaviyo.js --send   # real send
 *
 * Env (.env in repo root):
 *   KLAVIYO_PRIVATE_KEY   pk_... private API key (Klaviyo -> Settings ->
 *                         API keys -> Create Private API Key; needs Events
 *                         full access + Profiles write).
 */

const fs = require("fs");
const path = require("path");
const axios = require("axios");

try {
  fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8").split("\n").forEach((line) => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  });
} catch (e) { /* no .env */ }

const KEY = process.env.KLAVIYO_PRIVATE_KEY;
const SEND = process.argv.includes("--send");
const METRIC = "Shelf Digest";

async function pushEvent(digest) {
  const body = {
    data: {
      type: "event",
      attributes: {
        properties: {
          new_releases: digest.new_releases,
          behind: digest.behind,
          stats: digest.stats,
        },
        metric: { data: { type: "metric", attributes: { name: METRIC } } },
        profile: {
          data: {
            type: "profile",
            attributes: {
              email: digest.email,
              first_name: digest.first_name || undefined,
            },
          },
        },
      },
    },
  };
  await axios.post("https://a.klaviyo.com/api/events", body, {
    headers: {
      Authorization: `Klaviyo-API-Key ${KEY}`,
      "Content-Type": "application/vnd.api+json",
      accept: "application/vnd.api+json",
      revision: "2025-01-15",
    },
  });
}

async function main() {
  const digests = JSON.parse(fs.readFileSync(path.join(__dirname, "digests.json"), "utf8"));
  console.log(`${digests.length} digests loaded. Mode: ${SEND ? "SEND" : "dry run"}`);
  if (SEND && !KEY) {
    console.error("KLAVIYO_PRIVATE_KEY missing in .env — cannot send.");
    process.exit(1);
  }
  let sent = 0, failed = 0;
  for (const d of digests) {
    const summary = `${d.email}: ${d.new_releases.length} new, ${d.behind.length} catch-up, ${d.stats.volumes} vols (${d.stats.from_boxes} from boxes)`;
    if (!SEND) { console.log("DRY  " + summary); continue; }
    try {
      await pushEvent(d);
      sent++;
      console.log("SENT " + summary);
      await new Promise((r) => setTimeout(r, 200)); // gentle on rate limits
    } catch (e) {
      failed++;
      console.error("FAIL " + d.email + ": " + (e.response?.data ? JSON.stringify(e.response.data) : e.message));
    }
  }
  if (SEND) console.log(`Done: ${sent} sent, ${failed} failed.`);
}

main();
