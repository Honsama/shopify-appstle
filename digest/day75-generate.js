/*
 * Day-75 continuation touch — generator (churn plan #16, built 2026-10-27)
 * -----------------------------------------------------------------------
 * The month-2.5 continuation promise: "You've started N series. The next
 * volume of each is here, 15% off, ships in your box." One email per
 * subscriber, once in a lifetime, around day 75 of their subscription (the
 * months 3–5 churn cliff is a narrative-frustration cliff — every box is a
 * Vol. 1 — so this is the moment the continuation channels get pushed).
 *
 * Rides the Shelf Digest lane: same Shopify reads (generate.js), same
 * collection engine + series index, same Resend sender pattern
 * (day75-send.js), same one-tap add link and unsubscribe. The "series you've
 * started" come from order history + box credit, the source the one-tap spec
 * §11 chose over the volume-alert tags (a tag is written only when a product
 * carries custom.series_handle; order history sees every box and add-on).
 *
 *   node digest/day75-generate.js                 # writes digest/day75.json, prints who and why
 *   node digest/day75-generate.js --max-days 200  # widen the catch-up window (default 150)
 *   node digest/day75-generate.js --min-days 60   # (default 75)
 *
 * Who is in:
 *   - active subscriber (box order in the last 45 days, generate.js) AND the
 *     Appstle active tag AND Shopify marketing consent = SUBSCRIBED
 *   - tenure between --min-days and --max-days. Tenure = days since the first
 *     box order of the CURRENT run of box orders (a gap of more than
 *     RUN_GAP_DAYS between two box orders starts a new run, so a re-activated
 *     subscriber counts from the re-activation, and one skipped month does not
 *     break the run)
 *   - not already touched: not in day75-state.json and no honsama_day75_* tag
 *   - at least one started series whose next unowned volume is on sale
 *
 * What each email carries (up to MAX_SERIES cards, favorites first, then the
 * series a box started, then closest-to-complete): cover, series, the next
 * volume number, the subscriber price and the compare-at it is 15% under,
 * the one-tap add link (day75-send.js signs it) or the product page.
 *
 * Env: the same as generate.js (ADMIN_API_TOKEN or the client-credentials
 * fallback; box-history.json when metaobjects are unreadable). Optional
 * DAY75_MIN_DAYS / DAY75_MAX_DAYS; the flags win.
 */

const fs = require("fs");
const path = require("path");
const G = require("./generate"); // loads .env, the engine and the series index on require; runs nothing

const argv = process.argv.slice(2);
const flagValue = (name) => { const i = argv.indexOf(name); return i !== -1 ? argv[i + 1] : undefined; };
const MIN_DAYS = parseInt(flagValue("--min-days") || process.env.DAY75_MIN_DAYS || "75", 10);
const MAX_DAYS = parseInt(flagValue("--max-days") || process.env.DAY75_MAX_DAYS || "150", 10);
const RUN_GAP_DAYS = 70;      // one skipped month (~61 days between box orders) keeps the run; two break it
const MAX_SERIES = 6;
const ACTIVE_TAG = "appstle_subscription_active_customer";
const TAG_PREFIX = "honsama_day75_";

const STATE_PATH = path.join(__dirname, "day75-state.json");
const OUT_PATH = path.join(__dirname, "day75.json");

// Tags + the two My Library lists in one call.
async function fetchCustomerMeta(customerId) {
  const data = await G.adminGraphql(
    `query Meta($id: ID!) {
      customer(id: $id) {
        tags
        following: metafield(namespace: "honsama", key: "following") { value }
        favorites: metafield(namespace: "honsama", key: "favorites") { value }
      }
    }`,
    { id: customerId }
  );
  const parse = (v) => { try { const a = JSON.parse(v || "[]"); return Array.isArray(a) ? a : []; } catch (e) { return []; } };
  const c = data?.customer || {};
  return { tags: c.tags || [], following: parse(c.following?.value), favorites: parse(c.favorites?.value) };
}

// Start of the current run of box orders (see the header).
function runStart(boxOrderDates) {
  const ts = (boxOrderDates || []).map((d) => new Date(d).getTime()).filter((n) => !isNaN(n)).sort((a, b) => b - a);
  if (!ts.length) return null;
  let start = ts[0];
  let count = 1;
  for (let i = 1; i < ts.length; i++) {
    if ((start - ts[i]) / 864e5 > RUN_GAP_DAYS) break;
    start = ts[i];
    count++;
  }
  return { start, boxes: count };
}

// The series a subscriber has started whose next unowned volume is on the store.
function startedSeries(ownedData, meta, boxHistory) {
  const { owned, boxCredited } = G.creditBoxes(ownedData.skus, ownedData.boxMonths, ownedData.boxMonths2, boxHistory);
  const collection = G.eng.buildCollection(owned, G.seriesIndex);
  const favSet = new Set(meta.favorites);
  const ownedVols = new Set();
  owned.forEach((sku) => { const p = G.eng.parseSku(sku); if (p) ownedVols.add(p.seriesKey + "#" + p.volume); });

  const series = collection
    .filter((s) => !s.upToDate && s.total > 0)
    .map((s) => {
      const next = s.volumes.find((v) => !v.owned && v.variantId && /\/products\/[^/?#]+/.test(v.url || ""));
      if (!next) return null;
      const fromBox = s.volumes.some((v) => v.owned && v.sku && boxCredited[String(v.sku).trim().toUpperCase()]);
      return {
        series_key: s.seriesKey,
        series: s.name,
        owned_count: s.ownedCount,
        total: s.total,
        pct: s.pct,
        favorite: favSet.has(s.seriesKey),
        from_box: fromBox,
        next_volume: next.volume,
        next_sku: next.sku,
        variant_gid: next.variantId,
        variant_id: String(next.variantId).split("/").pop(),
        handle: /\/products\/([^/?#]+)/.exec(next.url)[1],
        url: next.url,
        cover: next.image || s.cover || "",
        price: next.price || "",
        compare_at: "",
      };
    })
    .filter(Boolean)
    .sort((a, b) => (b.favorite - a.favorite) || (b.from_box - a.from_box) || (b.pct - a.pct))
    .slice(0, MAX_SERIES);

  const boxVolumes = owned.filter((sku) => boxCredited[String(sku).trim().toUpperCase()] && G.eng.parseSku(sku)).length;
  return { series, stats: { series: collection.length, volumes: ownedVols.size, from_boxes: boxVolumes } };
}

// Live price / compare-at / on-sale check for every next volume, 50 ids a call.
// Returns a map gid -> {price, compareAtPrice, onSale}; null when the token cannot read products.
async function fetchVariants(gids) {
  const out = {};
  const ids = Array.from(new Set(gids));
  for (let i = 0; i < ids.length; i += 50) {
    let data;
    try {
      data = await G.adminGraphql(
        `query Variants($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on ProductVariant {
              id price compareAtPrice availableForSale
              product { status onlineStoreUrl }
            }
          }
        }`,
        { ids: ids.slice(i, i + 50) }
      );
    } catch (e) {
      if (/ACCESS_DENIED|Access denied/.test(e.message)) return null;
      throw e;
    }
    (data?.nodes || []).forEach((n) => {
      if (!n || !n.id) return;
      out[n.id] = {
        price: n.price,
        compareAtPrice: n.compareAtPrice,
        onSale: !!(n.availableForSale && n.product && n.product.status === "ACTIVE" && n.product.onlineStoreUrl),
      };
    });
  }
  return out;
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")); } catch (e) { return { sent: {}, failed: {} }; }
}

async function main() {
  const tokenSource = await G.resolveAdminToken();
  if (!tokenSource) {
    console.error("No Admin API access: set ADMIN_API_TOKEN in shopify-appstle/.env (rig) or make SHOPIFY_CLIENT_ID/SECRET reachable (dev PC).");
    process.exit(1);
  }
  console.log(`Admin API via ${tokenSource}`);
  console.log(`Window: day ${MIN_DAYS} to day ${MAX_DAYS} of the current subscription run · up to ${MAX_SERIES} series per email`);

  const state = loadState();
  const [boxHistory, subsResult] = await Promise.all([G.fetchBoxHistory(), G.fetchSubscribers()]);
  const months = Object.keys(boxHistory).sort();
  console.log(`box months: ${months.length} (latest ${months[months.length - 1]}) · active subscribers with SUBSCRIBED consent: ${subsResult.subscribers.length} (consent skipped ${subsResult.notSubscribed})`);
  const now = Date.now();
  // The newest box anyone can already be credited with: the one billed on the latest 21st
  // (Oct 21 bills the box that ships Nov 1 = "2026-11"). Before the 21st that is this month's box.
  const expectedLatest = (() => { const d = new Date(now); const m = d.getUTCMonth() + (d.getUTCDate() >= 21 ? 1 : 0); return `${d.getUTCFullYear() + Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, "0")}`; })();
  if (months[months.length - 1] < expectedLatest) {
    console.log(`WARNING: box history stops at ${months[months.length - 1]}; the ${expectedLatest} box is not credited yet (its series will be missing from the emails). Refresh box-history.json from the box_month metaobjects or run where the token can read them.`);
  }

  const out = [];
  const skipped = { not_active_tag: 0, too_new: 0, past_window: 0, already_sent: 0, already_tagged: 0, no_series: 0, error: 0 };
  const tenures = [];
  for (const sub of subsResult.subscribers) {
    try {
      const [ownedData, meta] = await Promise.all([G.fetchOwned(sub.id), fetchCustomerMeta(sub.id)]);
      const cid = String(sub.id).split("/").pop();
      if (!meta.tags.includes(ACTIVE_TAG)) { skipped.not_active_tag++; continue; }
      if (meta.tags.some((t) => String(t).startsWith(TAG_PREFIX))) { skipped.already_tagged++; continue; }
      if (state.sent && state.sent[cid]) { skipped.already_sent++; continue; }
      const run = runStart(ownedData.boxOrderDates);
      if (!run) { skipped.too_new++; continue; }
      const tenure = Math.floor((now - run.start) / 864e5);
      tenures.push(tenure);
      if (tenure < MIN_DAYS) { skipped.too_new++; continue; }
      if (tenure > MAX_DAYS) { skipped.past_window++; continue; }
      const { series, stats } = startedSeries(ownedData, meta, boxHistory);
      if (!series.length) { skipped.no_series++; continue; }
      out.push({
        customer_id: cid,
        email: sub.email,
        first_name: sub.firstName || "",
        tenure_days: tenure,
        boxes: run.boxes,
        run_start: new Date(run.start).toISOString().slice(0, 10),
        series,
        stats,
      });
      process.stdout.write(".");
    } catch (e) {
      skipped.error++;
      console.error(`\n${sub.email}: ${e.message}`);
    }
  }
  console.log("");

  // Live price / on-sale pass over every next volume.
  const variants = await fetchVariants(out.flatMap((d) => d.series.map((s) => s.variant_gid)));
  if (variants === null) {
    console.log("WARNING: the token cannot read product variants - prices come from series-index.json, compare-at is unknown and sold-out volumes are not filtered.");
  } else {
    let dropped = 0;
    out.forEach((d) => {
      d.series = d.series.filter((s) => {
        const v = variants[s.variant_gid];
        if (!v || !v.onSale) { dropped++; return false; }
        s.price = v.price || s.price;
        s.compare_at = v.compareAtPrice || "";
        return true;
      });
    });
    const before = out.length;
    for (let i = out.length - 1; i >= 0; i--) if (!out[i].series.length) { out.splice(i, 1); skipped.no_series++; }
    if (dropped) console.log(`${dropped} next volume(s) dropped (not on sale / sold out / not active); ${before - out.length} email(s) emptied by it`);
  }
  out.forEach((d) => { d.series.forEach((s) => { delete s.variant_gid; }); });

  // Summary
  tenures.sort((a, b) => a - b);
  const bucket = (lo, hi) => tenures.filter((t) => t >= lo && t <= hi).length;
  console.log(`\nTenure of active, consenting, untouched subscribers: <${MIN_DAYS}d ${bucket(0, MIN_DAYS - 1)} · ${MIN_DAYS}-${MAX_DAYS}d ${bucket(MIN_DAYS, MAX_DAYS)} · >${MAX_DAYS}d ${bucket(MAX_DAYS + 1, 99999)}`);
  console.log(`Skipped: no active tag ${skipped.not_active_tag} · too new ${skipped.too_new} · past window ${skipped.past_window} · already sent ${skipped.already_sent} · already tagged ${skipped.already_tagged} · nothing to continue ${skipped.no_series} · errors ${skipped.error}`);
  console.log(`\n${out.length} Day-75 email(s) to send:`);
  out.sort((a, b) => a.tenure_days - b.tenure_days).forEach((d) => {
    console.log(`  day ${String(d.tenure_days).padStart(3)} · ${d.boxes} box(es) · ${d.email} · ${d.series.length} series: ${d.series.map((s) => `${s.series} → Vol. ${s.next_volume}${s.from_box ? " (box)" : ""}`).join(" · ")}`);
  });
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 1));
  console.log(`\nWrote ${OUT_PATH}. Next: node digest/day75-send.js (dry run, samples in digest/samples/day75-*.html).`);
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { runStart, startedSeries, RUN_GAP_DAYS, MAX_SERIES };
