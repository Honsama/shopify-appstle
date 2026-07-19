/*
 * Honsama Shelf Digest — generator
 * --------------------------------
 * Computes one personalized digest per active subscriber:
 *   - "New this month for your series" (new volumes whose series the customer
 *     owns or follows, excluding volumes already owned)
 *   - Top behind-series ("catch up" — favorites first, then closest-to-done)
 *   - Shelf stats (series count, volumes, box-delivered count)
 * Writes digests.json for send-klaviyo.js.
 *
 * Run monthly, ~the 16th (after the add-ons run, before the 21st cutoff):
 *   node digest/generate.js
 *
 * Env (.env in repo root, same loader as dev-server):
 *   ADMIN_API_TOKEN   shpat_ token of the "Honsama Library Backend" custom app
 *                     (read_orders + read_all_orders + read_customers).
 *                     Copy from Vercel env vars.
 *   SHOP_DOMAIN       defaults honsama.myshopify.com
 * Optional:
 *   DIGEST_WINDOW_DAYS   how far back "new this month" looks (default 32)
 *   SUBSCRIBER_WINDOW    days of box orders that count as "active" (default 45)
 *   ENGINE_PATH          path to collection-engine.js
 *   SERIES_INDEX_PATH    path to series-index.json
 */

const fs = require("fs");
const path = require("path");
const axios = require("axios");

// .env loader (same minimal approach as dev-server.js)
try {
  fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8").split("\n").forEach((line) => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  });
} catch (e) { /* no .env */ }

const SHOP_DOMAIN = process.env.SHOP_DOMAIN || "honsama.myshopify.com";
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN;
const API_VERSION = "2025-10";
const WINDOW_DAYS = parseInt(process.env.DIGEST_WINDOW_DAYS || "32", 10);
const SUBSCRIBER_WINDOW = parseInt(process.env.SUBSCRIBER_WINDOW || "45", 10);

const ENGINE_PATH = process.env.ENGINE_PATH ||
  path.join(__dirname, "..", "..", "honsama-app", "theme", "assets", "collection-engine.js");
const SERIES_INDEX_PATH = process.env.SERIES_INDEX_PATH ||
  path.join(__dirname, "..", "..", "honsama-app", "theme", "assets", "series-index.json");

const eng = require(ENGINE_PATH);
const seriesIndex = JSON.parse(fs.readFileSync(SERIES_INDEX_PATH, "utf8"));

// Monthly Manga Box product + 2-Manga variant (same ids as index.js)
const BOX_PRODUCT_ID = "8150096773420";
const BOX_VARIANT_2MANGA_ID = "52361633005868";

async function adminGraphql(query, variables) {
  const response = await axios.post(
    `https://${SHOP_DOMAIN}/admin/api/${API_VERSION}/graphql.json`,
    { query, variables },
    { headers: { "X-Shopify-Access-Token": ADMIN_API_TOKEN, "Content-Type": "application/json" } }
  );
  if (response.data.errors) throw new Error(JSON.stringify(response.data.errors));
  return response.data.data;
}

// Box month = billing month + 1; billed day <= 22 -> +1, >= 23 -> +2.
// (Same rule as index.js ownedHandler; dates approximated to store time.)
function boxMonthOf(createdAt) {
  const d = new Date(new Date(createdAt).getTime() - 7 * 3600 * 1000);
  const delta = d.getUTCDate() <= 22 ? 1 : 2;
  const midx = d.getUTCMonth() + delta;
  return `${d.getUTCFullYear() + Math.floor(midx / 12)}-${String((midx % 12) + 1).padStart(2, "0")}`;
}

// ---- data pulls -----------------------------------------------------------

// Active subscribers = customers with a Monthly Manga Box order in the last
// SUBSCRIBER_WINDOW days (billing runs monthly, so this catches everyone
// active without needing Appstle contract enumeration).
async function fetchSubscribers() {
  const since = new Date(Date.now() - SUBSCRIBER_WINDOW * 86400 * 1000).toISOString().slice(0, 10);
  const subs = new Map(); // customerId -> {email, firstName}
  let after = null;
  for (let page = 0; page < 10; page++) {
    const data = await adminGraphql(
      `query BoxOrders($q: String!, $after: String) {
        orders(first: 100, query: $q, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            customer { id email firstName }
            lineItems(first: 20) { nodes { product { id } } }
          }
        }
      }`,
      { q: `created_at:>=${since}`, after }
    );
    const orders = data.orders;
    orders.nodes.forEach((o) => {
      if (!o.customer || !o.customer.email) return;
      const hasBox = (o.lineItems?.nodes || []).some((li) => li.product?.id?.endsWith(`/${BOX_PRODUCT_ID}`));
      if (hasBox) subs.set(o.customer.id, { id: o.customer.id, email: o.customer.email, firstName: o.customer.firstName || "" });
    });
    if (!orders.pageInfo.hasNextPage) break;
    after = orders.pageInfo.endCursor;
  }
  return Array.from(subs.values());
}

// Full order history for one customer -> { skus[], boxMonths[], boxMonths2[] }
async function fetchOwned(customerId) {
  const skus = [];
  const boxMonths = new Set(); const boxMonths2 = new Set();
  let after = null;
  for (let page = 0; page < 30; page++) {
    const data = await adminGraphql(
      `query Owned($id: ID!, $after: String) {
        customer(id: $id) {
          orders(first: 100, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes { createdAt lineItems(first: 100) { nodes { sku product { id } variant { id } } } }
          }
        }
      }`,
      { id: customerId, after }
    );
    const orders = data?.customer?.orders;
    if (!orders) break;
    orders.nodes.forEach((o) => {
      (o.lineItems?.nodes || []).forEach((li) => {
        if (li.sku) skus.push(li.sku);
        if (li.product?.id?.endsWith(`/${BOX_PRODUCT_ID}`)) {
          const month = boxMonthOf(o.createdAt);
          if (li.variant?.id?.endsWith(`/${BOX_VARIANT_2MANGA_ID}`)) boxMonths2.add(month);
          else boxMonths.add(month);
        }
      });
    });
    if (!orders.pageInfo.hasNextPage) break;
    after = orders.pageInfo.endCursor;
  }
  return { skus: Array.from(new Set(skus)), boxMonths: Array.from(boxMonths), boxMonths2: Array.from(boxMonths2) };
}

async function fetchCustomerLists(customerId) {
  const data = await adminGraphql(
    `query Lists($id: ID!) {
      customer(id: $id) {
        following: metafield(namespace: "honsama", key: "following") { value }
        favorites: metafield(namespace: "honsama", key: "favorites") { value }
      }
    }`,
    { id: customerId }
  );
  const parse = (v) => { try { const a = JSON.parse(v || "[]"); return Array.isArray(a) ? a : []; } catch (e) { return []; } };
  return {
    following: parse(data?.customer?.following?.value),
    favorites: parse(data?.customer?.favorites?.value),
  };
}

// box_month metaobjects -> { "YYYY-MM": { skus:[], skus2:[] } }
async function fetchBoxHistory() {
  const data = await adminGraphql(
    `query Boxes { metaobjects(type: "box_month", first: 100) { nodes { fields { key value } } } }`, {});
  const hist = {};
  (data?.metaobjects?.nodes || []).forEach((n) => {
    const f = {}; n.fields.forEach((x) => { f[x.key] = x.value; });
    const parse = (v) => { try { const a = JSON.parse(v || "[]"); return Array.isArray(a) ? a : []; } catch (e) { return []; } };
    if (f.month) hist[f.month] = { skus: parse(f.manga_skus), skus2: parse(f.manga_skus_2) };
  });
  return hist;
}

// New releases = products created in the window whose SKU parses as a volume.
async function fetchNewReleases() {
  const since = new Date(Date.now() - WINDOW_DAYS * 86400 * 1000).toISOString().slice(0, 10);
  const out = [];
  let after = null;
  for (let page = 0; page < 5; page++) {
    const data = await adminGraphql(
      `query NewProducts($q: String!, $after: String) {
        products(first: 100, query: $q, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            title handle status onlineStoreUrl
            featuredMedia { preview { image { url } } }
            variants(first: 1) { nodes { sku price } }
          }
        }
      }`,
      { q: `created_at:>=${since} status:active`, after }
    );
    const products = data.products;
    products.nodes.forEach((p) => {
      const sku = p.variants?.nodes?.[0]?.sku;
      const parsed = eng.parseSku(sku);
      if (!parsed || !p.onlineStoreUrl) return; // volumes only, published only
      if (p.handle.endsWith("-easify")) return;
      out.push({
        seriesKey: parsed.seriesKey,
        volume: parsed.volume,
        sku,
        title: p.title,
        url: `https://honsama.com/products/${p.handle}`,
        image: p.featuredMedia?.preview?.image?.url || "",
        price: p.variants?.nodes?.[0]?.price || "",
      });
    });
    if (!products.pageInfo.hasNextPage) break;
    after = products.pageInfo.endCursor;
  }
  return out;
}

// ---- digest assembly ------------------------------------------------------

function creditBoxes(skus, boxMonths, boxMonths2, boxHistory) {
  const owned = skus.slice();
  const boxCredited = {};
  const credit = (months, preferTwo) => {
    months.forEach((m) => {
      const e = boxHistory[m];
      if (!e) return;
      const list = (preferTwo && e.skus2 && e.skus2.length) ? e.skus2 : (e.skus || []);
      list.forEach((s) => {
        if (!s) return;
        const up = String(s).trim().toUpperCase();
        boxCredited[up] = true;
        if (owned.indexOf(up) === -1) owned.push(up);
      });
    });
  };
  credit(boxMonths, false);
  credit(boxMonths2, true);
  return { owned, boxCredited };
}

function buildDigest(customer, ownedData, lists, boxHistory, newReleases) {
  const { owned, boxCredited } = creditBoxes(ownedData.skus, ownedData.boxMonths, ownedData.boxMonths2, boxHistory);
  const collection = eng.buildCollection(owned, seriesIndex);
  if (!collection.length) return null; // nothing on the shelf -> skip

  const ownedSeries = new Set(collection.map((s) => s.seriesKey));
  const ownedVols = new Set();
  owned.forEach((sku) => { const p = eng.parseSku(sku); if (p) ownedVols.add(p.seriesKey + "#" + p.volume); });
  const followSet = new Set(lists.following);
  const favSet = new Set(lists.favorites);

  // New for you: new releases in series you own or follow, not already owned.
  const newForYou = newReleases
    .filter((r) => (ownedSeries.has(r.seriesKey) || followSet.has(r.seriesKey)) && !ownedVols.has(r.seriesKey + "#" + r.volume))
    .map((r) => {
      const cat = seriesIndex[r.seriesKey] || {};
      return {
        series: cat.name || r.title,
        volume: r.volume,
        title: r.title,
        url: r.url,
        image: r.image || cat.cover || "",
        price: r.price,
        reason: followSet.has(r.seriesKey) && !ownedSeries.has(r.seriesKey) ? "following" : "on your shelf",
      };
    })
    .slice(0, 6);

  // Catch up: behind series — favorites first, then engine order (closest first).
  const behindAll = collection.filter((s) => !s.upToDate && s.total > 0);
  const behind = behindAll
    .sort((a, b) => (favSet.has(b.seriesKey) - favSet.has(a.seriesKey)) || (b.pct - a.pct))
    .slice(0, 3)
    .map((s) => {
      const cat = seriesIndex[s.seriesKey] || {};
      return {
        series: s.name,
        owned: s.ownedCount,
        total: s.total,
        behind: s.behind,
        pct: s.pct,
        favorite: favSet.has(s.seriesKey),
        cover: s.cover || "",
        url: cat.curl ? `https://honsama.com${cat.curl}` : (s.volumes[0] && s.volumes[0].url) || "https://honsama.com/pages/my-library",
      };
    });

  const boxVolumes = owned.filter((sku) => boxCredited[String(sku).trim().toUpperCase()] && eng.parseSku(sku)).length;
  const totalVolumes = ownedVols.size;
  const upToDate = collection.filter((s) => s.upToDate).length;

  return {
    email: customer.email,
    first_name: customer.firstName || "",
    new_releases: newForYou,
    behind,
    stats: {
      series: collection.length,
      volumes: totalVolumes,
      from_boxes: boxVolumes,
      up_to_date: upToDate,
      behind_total: behindAll.reduce((n, s) => n + s.behind, 0),
    },
  };
}

// ---- main -----------------------------------------------------------------

async function main() {
  if (!ADMIN_API_TOKEN) {
    console.error("ADMIN_API_TOKEN missing — copy it from Vercel env into shopify-appstle/.env");
    process.exit(1);
  }
  console.log("Fetching box history, new releases, subscribers...");
  const [boxHistory, newReleases, subscribers] = await Promise.all([
    fetchBoxHistory(), fetchNewReleases(), fetchSubscribers(),
  ]);
  console.log(`box months: ${Object.keys(boxHistory).length}, new releases: ${newReleases.length}, subscribers: ${subscribers.length}`);

  const digests = [];
  for (const sub of subscribers) {
    try {
      const [ownedData, lists] = await Promise.all([fetchOwned(sub.id), fetchCustomerLists(sub.id)]);
      const digest = buildDigest(sub, ownedData, lists, boxHistory, newReleases);
      if (digest) digests.push(digest);
      process.stdout.write(".");
    } catch (e) {
      console.error(`\n${sub.email}: ${e.message}`);
    }
  }
  console.log(`\n${digests.length} digests built (${subscribers.length - digests.length} skipped: empty shelf/error)`);
  const outPath = path.join(__dirname, "digests.json");
  fs.writeFileSync(outPath, JSON.stringify(digests, null, 1));
  console.log("Wrote", outPath);
}

if (require.main === module) main();
module.exports = { buildDigest, creditBoxes, boxMonthOf };
