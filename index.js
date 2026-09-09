const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const cors = require("cors");
const https = require("https");

// ---------------------------------------------------------------------------
// TRANSPORT DEFAULTS (2026-08-20, revised 2026-09-05)
//
// KEEP-ALIVE: DELIBERATELY OFF. It was on from 2026-08-20 to save a 25-55ms
// TLS handshake per call (TLS complete at 30-80ms on a cold socket). That
// saving is real but small, and it is bought with a race this proxy cannot
// afford: a pooled socket Appstle has already closed is still handed to the
// next request, which then fails with ECONNRESET / "socket hang up" before
// the request is even written. Nothing here catches that — the only retry
// logic in this file is for Shopify metafield STALE_OBJECT conflicts — so it
// reaches the customer as a single volume that silently failed to add.
//
// The trade is lopsided. One handshake costs 30-80ms against an Appstle write
// measured at 2,500-5,000ms: about 1%. A dropped write costs a volume the
// customer believes they bought.
//
// Two alternatives were rejected:
//
//   - Retrying on ECONNRESET. A socket hang up on a PUT is ambiguous — the
//     contract edit may already have landed — so a blind retry risks adding
//     the same volume twice. Not worth it to keep a 1% saving.
//
//   - Evicting idle sockets via the agent `timeout` option. In Node that
//     applies to sockets in use as well as free ones, so any value low enough
//     to beat Appstle's idle close (which we do not know) would also abort
//     live writes that legitimately take 5s.
//
// The agent has to be explicit. Deleting these two lines would NOT restore
// pre-2026-08-20 behaviour: package.json pins no `engines`, so this runs on
// whatever Node version Vercel defaults to, and Node 19+ ships
// https.globalAgent with keepAlive already true. Off must be stated.
//
// TIMEOUT (unchanged). There was none, so a hung upstream pinned the function
// until the platform killed it, with no useful error. 20s is deliberately
// generous: the slowest add observed is 4.8s, and cutting a WRITE short is
// worse than waiting — the contract edit may still land while the client is
// told it failed. This only fires on a genuinely stuck call, and turns an
// opaque platform timeout into a clean 502.
// ---------------------------------------------------------------------------
const appstleAgent = new https.Agent({ keepAlive: false, maxSockets: 64 });
axios.defaults.httpsAgent = appstleAgent;
axios.defaults.timeout = 20000;

const app = express();
app.use(express.json({ limit: "100kb" }));

// Environment Variables (Securely stored in Vercel)
const APPSTLE_API_KEY = process.env.APPSTLE_API_KEY;
const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
const APP_URL = process.env.APP_URL; // Your Vercel App URL
// Admin API token (shpat_...) from a store-owned custom app with read_orders +
// read_all_orders — lets /owned walk a customer's ENTIRE order history (the
// storefront Liquid customer.orders loop caps at ~50 orders, and app tokens
// without read_all_orders only see 60 days).
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN;
const SHOP_DOMAIN = process.env.SHOP_DOMAIN || "honsama.myshopify.com";

// ✅ Allowed Origins (Multiple)
const allowedOrigins = [
    "https://honsama.com",
    "https://honsama.myshopify.com",
    "http://127.0.0.1:9292",
    "https://3ojk4ln0rxpnbfd5-72372584748.shopifypreview.com",
];

// ✅ Dynamic CORS Configuration
app.use(
    cors({
        origin: (origin, callback) => {
            // Allow requests with no origin (like mobile apps or CURL)
            if (!origin) return callback(null, true);
            if (allowedOrigins.includes(origin)) {
                callback(null, true);
            } else {
                callback(new Error("Not allowed by CORS"));
            }
        },
        methods: ["GET", "POST", "PUT", "DELETE"],
        allowedHeaders: ["Content-Type", "Authorization"],
        credentials: true
    })
);

// ✅ Root Route (Home Page)
app.get("/", (req, res) => {
    res.send("<h1>Your Appstle API Proxy is running successfully.</h1>");
});

// 🔒 Auth gate for all Appstle proxy routes.
// CORS alone does NOT protect these — non-browser callers (the mobile app, curl) send no
// Origin, which CORS lets through. Without this, anyone who guesses a customerId/contractId
// could read or modify another customer's subscription box. Require a shared app token.
//
// NOTE: this stops anonymous abuse. Full per-user authorization (verify the logged-in
// customer actually OWNS the contract they're acting on) lands with the Customer Account
// API login — at that point, validate the customer's token and match it to the contract.
function safeEqual(a, b) {
    const ba = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
}

// FAIL-CLOSED: the theme's subscription cart drawer now talks exclusively to
// the signed App Proxy routes (/apps/appstle-proxy/* → SIGNED_PATHS below),
// so nothing legitimate depends on the legacy contractId-accepting routes
// being open. If APP_API_TOKEN is unset, legacy routes are DENIED — an unset
// env var must never mean "everyone on the internet can mutate subscriptions".
function requireAppToken(req, res, next) {
    // /box and /box-add live under /api/appstle only because the store's App
    // Proxy ("Appstle API Connector Honsama") already targets this prefix —
    // they carry their own auth (Shopify's App Proxy signature +
    // logged_in_customer_id) — the bearer gate must never apply to them.
    var SIGNED_PATHS = ["/box", "/box-add", "/owned", "/owned-declare", "/box-details", "/box-remove", "/box-skip", "/box-discount", "/follow", "/unfollow", "/favorite", "/unfavorite"];
    if (SIGNED_PATHS.indexOf(req.path) !== -1) return next();
    if (!process.env.APP_API_TOKEN) {
        console.warn("APP_API_TOKEN not set - denying legacy /api/appstle request (fail-closed).");
        return res.status(401).json({ error: "Unauthorized." });
    }
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    if (!token || !safeEqual(token, process.env.APP_API_TOKEN)) {
        return res.status(401).json({ error: "Unauthorized." });
    }
    next();
}

// 🔒 Only ever talk OAuth to a real *.myshopify.com domain. Without this,
// /auth is an open redirect and /auth/callback will POST the app's client
// secret to whatever host an attacker puts in ?shop= (secret exfiltration).
function isValidShopDomain(shop) {
    return typeof shop === "string" && /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop);
}

// Stateless CSRF state for OAuth (no DB on serverless): ts.hmac(ts), verified
// on callback within a 10-minute window.
function makeOauthState() {
    const ts = Date.now().toString();
    const sig = crypto.createHmac("sha256", SHOPIFY_API_SECRET).update(ts).digest("hex");
    return ts + "." + sig;
}
function verifyOauthState(state) {
    if (typeof state !== "string") return false;
    const parts = state.split(".");
    if (parts.length !== 2) return false;
    const expected = crypto.createHmac("sha256", SHOPIFY_API_SECRET).update(parts[0]).digest("hex");
    if (!safeEqual(parts[1], expected)) return false;
    return Math.abs(Date.now() - parseInt(parts[0], 10)) < 10 * 60 * 1000;
}

// Verify the hmac query param Shopify signs onto the OAuth callback:
// HMAC-SHA256 over the sorted query string minus hmac, keyed by the secret.
function verifyShopifyHmac(query) {
    const { hmac, ...rest } = query;
    if (!hmac) return false;
    const message = Object.keys(rest)
        .sort()
        .map((k) => `${k}=${rest[k]}`)
        .join("&");
    const digest = crypto.createHmac("sha256", SHOPIFY_API_SECRET).update(message).digest("hex");
    return safeEqual(digest, hmac);
}

// 🔑 Every route below ultimately calls Appstle's external API — fail fast and
// loud if the key isn't configured, instead of sending "X-API-Key: undefined"
// upstream and surfacing a confusing Appstle 401.
function requireAppstleKey(req, res, next) {
    if (!APPSTLE_API_KEY) {
        return res.status(500).json({ error: "Server misconfigured: APPSTLE_API_KEY not set." });
    }
    next();
}

app.use("/api/appstle", requireAppToken, requireAppstleKey);

// ✅ Shopify OAuth Installation Route
app.get("/auth", (req, res) => {
    const shop = req.query.shop;
    if (!isValidShopDomain(shop)) {
        return res.status(400).send("Invalid shop parameter.");
    }

    const state = makeOauthState();
    // Shopify requires redirect_uri's host to match the app's configured URL
    // (shopify-appstle.vercel.app). If APP_URL is unset the old template made
    // "undefined/auth/callback" → invalid_request. Fall back to the request host.
    const base = APP_URL || `https://${req.get("host")}`;
    const redirectUri = `${base}/auth/callback`;

    console.log("DEBUG - Redirecting to:", redirectUri);

    // read_all_orders is a protected scope with NO checkbox in the dev
    // dashboard — but custom (non-public) apps may request it via OAuth
    // without review. It lifts the 60-day order window for /owned.
    // write_customers lets /follow + /unfollow write the honsama.following
    // customer metafield (the Follow-series feature).
    const installUrl =
        `https://${shop}/admin/oauth/authorize?client_id=${SHOPIFY_API_KEY}` +
        `&scope=read_orders,read_all_orders,write_orders,read_customers,write_customers` +
        `&state=${state}&redirect_uri=${redirectUri}`;

    console.log("DEBUG - Installation URL:", installUrl);
    res.redirect(installUrl);
});

// ✅ OAuth Callback (Secure Token Exchange)
app.get("/auth/callback", async (req, res) => {
    const { shop, code, state } = req.query;

    if (!shop || !code) {
        return res.status(400).send("Invalid parameters.");
    }
    // Never exchange (or even talk to) a host that isn't a myshopify domain —
    // the exchange request carries the client secret.
    if (!isValidShopDomain(shop)) {
        return res.status(400).send("Invalid shop parameter.");
    }
    if (!verifyOauthState(state)) {
        return res.status(403).send("Invalid or expired state parameter.");
    }
    if (!verifyShopifyHmac(req.query)) {
        return res.status(403).send("HMAC validation failed.");
    }

    try {
        const tokenResponse = await axios.post(
            `https://${shop}/admin/oauth/access_token`,
            {
                client_id: SHOPIFY_API_KEY,
                client_secret: SHOPIFY_API_SECRET,
                code,
            }
        );

        // Shown ONCE to whoever completed the install (requires store-owner
        // login). This app has no database, so the token is displayed for
        // manual transfer into Vercel env ADMIN_API_TOKEN — copy it, save it,
        // close this tab. Re-running /auth issues a fresh token.
        const token = tokenResponse.data.access_token || "";
        const scopes = tokenResponse.data.scope || "";
        const hasAllOrders = scopes.split(",").indexOf("read_all_orders") !== -1;
        res.send(
            "<h1>App installed successfully.</h1>" +
            "<p><strong>Granted scopes:</strong> <code>" + scopes + "</code></p>" +
            (hasAllOrders
                ? "<p>✅ <code>read_all_orders</code> granted — full order history unlocked.</p>"
                : "<p>⚠️ <code>read_all_orders</code> NOT granted — the /owned endpoint will stay limited to 60 days.</p>") +
            "<p><strong>Admin API access token</strong> (copy into Vercel env <code>ADMIN_API_TOKEN</code>, then redeploy — this is shown only here, keep it secret):</p>" +
            "<pre style='font-size:16px;background:#f4f4f4;padding:12px;border-radius:6px;'>" + token + "</pre>"
        );
    } catch (error) {
        console.error("OAuth Error:", error.message);
        res.status(500).send("Failed to complete OAuth.");
    }
});

// ✅ Get api subscription customers contract Id
app.get("/api/appstle/:customerId", async (req, res, next) => {
    const { customerId } = req.params;

    // Customer ids are numeric. Anything else (e.g. "box") belongs to the
    // signed App Proxy routes registered further down — let it fall through.
    if (!/^\d+$/.test(customerId)) return next();

    try {
        const response = await axios.get(
            `https://subscription-admin.appstle.com/api/external/v2/subscription-customers/${customerId}`,
            {
                headers: {
                    "X-API-Key": APPSTLE_API_KEY,
                    "Content-Type": "application/json",
                },
            }
        );

        res.status(200).json(response.data);
    } catch (error) {
        console.error("Error fetching customer data:", error.message);
        res.status(500).json({ error: "Failed to fetch customer data." });
    }
});

// ✅ POST api Add a product subscription
app.post("/api/appstle/add-line-item", async (req, res) => {
    const { variantId, contractId, quantity, isOneTimeProduct } = req.body;

    if (!variantId || !contractId || !quantity || typeof isOneTimeProduct === "undefined") {
        return res.status(400).json({ error: "Missing required parameters." });
    }

    try {
        const url = `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts-add-line-item?contractId=${contractId}&quantity=${quantity}&variantId=${variantId}&isOneTimeProduct=${isOneTimeProduct}`;

        const response = await axios.put(url, {}, {
            headers: {
                "X-API-Key": APPSTLE_API_KEY,
                "Content-Type": "application/json",
            },
        });

        res.status(200).json(response.data);
    } catch (error) {
        console.error("Error adding line item:", error.response?.data || error.message);
        res.status(500).json({
            error: "Failed to add line item.",
            details: error.response?.data || error.message,
        });
    }
});

// ✅ POST api Get subscription contract details & products
app.post("/api/appstle/contract-details", async (req, res) => {
    const { subscriptionContractId } = req.body;

    if (!subscriptionContractId) {
        return res.status(400).json({ error: "Missing subscriptionContractId" });
    }

    const page = 0;
    const size = 10;
    const sort = "id,desc";

    try {
        const url = `https://subscription-admin.appstle.com/api/external/v2/subscription-contract-details?subscriptionContractId=${subscriptionContractId}&page=${page}&size=${size}&sort=${sort}`;

        const response = await axios.get(url, {
            headers: {
                "X-API-Key": APPSTLE_API_KEY,
                "Content-Type": "application/json",
            },
        });

        const contractData = response.data;

        const parsedData = contractData.map((item) => {
            // Parse each known stringified field
            const fieldsToParse = [
                { from: "contractDetailsJSON", to: "contractDetails" },
                { from: "orderNoteAttributes", to: "orderNoteAttributesParsed" },
                { from: "lastSuccessfulOrder", to: "lastSuccessfulOrderParsed" }
            ];

            fieldsToParse.forEach(({ from, to }) => {
                if (item[from]) {
                    try {
                        item[to] = JSON.parse(item[from]);
                    } catch (err) {
                        console.warn(`Failed to parse ${from}:`, err.message);
                        item[to] = null;
                    }
                }
            });

            return item;
        });

        res.status(200).json(parsedData);
    } catch (error) {
        console.error("Error fetching contract details:", error.response?.data || error.message);
        res.status(500).json({ error: "Failed to fetch subscription contract details." });
    }
});

// ✅ POST api Remove subscription item
app.post("/api/appstle/remove-line-item", async (req, res) => {
    const { contractId, lineId, removeDiscount = true } = req.body;

    if (!contractId || !lineId) {
        return res.status(400).json({ error: "Missing required parameters: contractId and lineId are required." });
    }

    try {
        const encodedLineId = encodeURIComponent(lineId);
        const url = `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts-remove-line-item?contractId=${contractId}&lineId=${encodedLineId}&removeDiscount=${removeDiscount}`;

        const response = await axios.put(url, {}, {
            headers: {
                "X-API-Key": APPSTLE_API_KEY,
                "Content-Type": "application/json",
            },
        });

        res.status(200).json(response.data);
    } catch (error) {
        console.error("Error removing line item:", error.response?.data || error.message);
        res.status(500).json({
            error: "Failed to remove line item.",
            details: error.response?.data || error.message,
        });
    }
});

// ✅ POST api Skip upcoming order
// This endpoint allows you to skip the upcoming order for a subscription contract
app.post("/api/appstle/skip-upcoming-order", async (req, res) => {
    const { contractId } = req.body;

    if (!contractId) {
        return res.status(400).json({ error: "Missing required parameter: contractId" });
    }

    try {
        const url = `https://subscription-admin.appstle.com/api/external/v2/subscription-billing-attempts/skip-upcoming-order?subscriptionContractId=${contractId}`;

        const response = await axios.put(url, {}, {
            headers: {
                "X-API-Key": APPSTLE_API_KEY,
                "Content-Type": "application/json",
            },
        });

        res.status(200).json({ message: "Upcoming order skipped successfully", data: response.data });
    } catch (error) {
        console.error("Error skipping upcoming order:", error.response?.data || error.message);
        res.status(500).json({
            error: "Failed to skip upcoming order.",
            details: error.response?.data || error.message,
        });
    }
});

// ✅ POST api Apply Discount Code
app.post("/api/appstle/apply-discount", async (req, res) => {
    const { contractId, discountCode } = req.body;

    if (!contractId || !discountCode) {
        return res.status(400).json({ error: "Missing required parameters: contractId and discountCode" });
    }

    try {
        const url = `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts-apply-discount?contractId=${contractId}&discountCode=${encodeURIComponent(discountCode)}`;

        const response = await axios.put(url, {}, {
            headers: {
                "X-API-Key": APPSTLE_API_KEY,
                "Content-Type": "application/json",
            },
        });

        res.status(200).json({ message: "Discount applied successfully", data: response.data });
    } catch (error) {
        console.error("Error applying discount:", error.response?.data || error.message);
        res.status(500).json({
            error: "Failed to apply discount.",
            details: error.response?.data || error.message,
        });
    }
});


// ============================================================================
// 🛡️ Shopify App Proxy routes (storefront-facing, per-customer)
// ----------------------------------------------------------------------------
// The Honsama bookshelf (honsama.com/pages/my-library) calls these through a
// Shopify App Proxy:  honsama.com/apps/appstle/*  →  {this app}/proxy/*
//
// Shopify signs every forwarded request (`signature` query param, HMAC-SHA256
// of the sorted query string with the app's API secret) and injects
// `logged_in_customer_id`. So, unlike the /api/appstle routes above (shared
// bearer token, trusted server callers), these routes are safe to call from
// storefront JS with NO secret in the page: we verify Shopify's signature and
// only ever act on the logged-in customer's own contract.
//
// ADD-ONLY by design: remove/skip/discount are deliberately NOT exposed here —
// customers manage removals in the Appstle portal widget.
// ============================================================================

// Verify a Shopify App Proxy signature: sort query params (minus `signature`),
// join as `key=value` with NO separator (array values comma-joined), HMAC-SHA256
// hex with the app's API secret.
function verifyAppProxy(req, res, next) {
    if (!SHOPIFY_API_SECRET) {
        return res.status(500).json({ error: "Server misconfigured: SHOPIFY_API_SECRET not set." });
    }
    const { signature, ...params } = req.query;
    if (!signature) return res.status(401).json({ error: "Missing signature." });

    const message = Object.keys(params)
        .sort()
        .map((k) => `${k}=${Array.isArray(params[k]) ? params[k].join(",") : params[k]}`)
        .join("");
    const digest = crypto.createHmac("sha256", SHOPIFY_API_SECRET).update(message).digest("hex");
    if (!safeEqual(digest, signature)) {
        return res.status(401).json({ error: "Invalid signature." });
    }

    // Freshness: proxy fetches happen live from the storefront; a large skew
    // means a replayed URL.
    const ts = parseInt(params.timestamp, 10);
    if (!ts || Math.abs(Date.now() / 1000 - ts) > 600) {
        return res.status(401).json({ error: "Stale request." });
    }

    // Shopify only fills this for logged-in customers; empty = anonymous visitor.
    const customerId = String(params.logged_in_customer_id || "").trim();
    if (!/^\d+$/.test(customerId)) {
        return res.status(401).json({ error: "Not logged in." });
    }
    req.customerId = customerId;
    next();
}

app.use("/proxy", verifyAppProxy, requireAppstleKey);

// Look up the customer's subscription contract server-side. The client never
// supplies a contractId — that's the whole per-customer security model.
//
// A customer's contract id is stable, so cache it per warm instance (10 min
// TTL) — this removes one of the two sequential Appstle round-trips from every
// repeat action (add/remove/skip/details), roughly halving server latency.
// Null results (no subscription) are NOT cached, so a customer who subscribes
// mid-session isn't locked out.
const contractCache = new Map(); // customerId -> { contract, at }
const CONTRACT_TTL_MS = 10 * 60 * 1000;

async function getContractForCustomer(customerId) {
    const hit = contractCache.get(customerId);
    if (hit && Date.now() - hit.at < CONTRACT_TTL_MS) return hit.contract;

    const response = await axios.get(
        `https://subscription-admin.appstle.com/api/external/v2/subscription-customers/${customerId}`,
        { headers: { "X-API-Key": APPSTLE_API_KEY, "Content-Type": "application/json" } }
    );
    // Appstle's real shape (confirmed from the live cart-drawer integration):
    //   { subscriptionContracts: { nodes: [ { id: "gid://shopify/SubscriptionContract/123", status: "ACTIVE", ... } ] } }
    // Keep the flat-array fallback in case other tenants/versions differ.
    const data = response.data || {};
    const rows = (data.subscriptionContracts && data.subscriptionContracts.nodes) ||
        (Array.isArray(data) ? data : [data]);
    const contracts = rows
        .map((r) => ({
            // gid or bare numeric → bare numeric (what the external API's contractId param wants)
            id: String(r.subscriptionContractId || r.contractId || r.id || "").split("/").pop(),
            status: String(r.status || "").toUpperCase(),
        }))
        .filter((c) => /^\d+$/.test(c.id));
    // POLICY (Ricky, 2026-07-07): ACTIVE contracts only. Paused/cancelled
    // customers are treated as non-subscribers — /box reports subscribed:false
    // (the bookshelf shows its subscribe nudge) and /box-add refuses.
    const contract = contracts.find((c) => c.status === "ACTIVE") || null;
    // Cache hits skip the lookup entirely, so a cancellation can take up to
    // CONTRACT_TTL_MS to be noticed here — Appstle still rejects writes against
    // a dead contract, so the worst case is a clean upstream error.
    if (contract) contractCache.set(customerId, { contract, at: Date.now() });
    return contract;
}

// Recursively collect every `sku` string in the contract payload — resilient to
// Appstle's nested contract-details shape.
function collectSkus(node, out) {
    out = out || [];
    if (Array.isArray(node)) { node.forEach((n) => collectSkus(n, out)); }
    else if (node && typeof node === "object") {
        Object.keys(node).forEach((k) => {
            if (k === "sku" && typeof node[k] === "string" && node[k]) out.push(node[k]);
            else collectSkus(node[k], out);
        });
    }
    return out;
}

// Every storefront route answers a failure with 409, never a 5xx.
//
// These are reachable ONLY through Shopify's App Proxy, and Shopify REPLACES
// the body of any 5xx with its own themed storefront error page. A real
// capture from 6 Sep 2026, taken in the browser:
//
//   proxy 500 <!doctype html><html class="js" lang="en"> ... LayoutHub
//
// The JSON, and the upstream reason inside it, never reaches the client. Five
// dropped volumes went undiagnosed because of exactly that, and the client-side
// logging added to catch them could not work either. #3 hit this first on
// /owned, #9 fixed it for box-add, #11 for box-remove; this finishes the set.
//
// SAFE BY CONSTRUCTION: 409 and 502 are both non-2xx, so every existing client
// check (`r.ok ? r.json() : null`) behaves exactly as before. The only thing
// that changes is that the body survives.
//
// NOT the 200-with-degraded-payload shape /owned uses. That works there because
// an empty list is a meaningful answer; for /box it would be actively harmful,
// because {subscribed:false} is how the bookshelf decides to show a SUBSCRIBE
// nudge — a read failure would tell a paying subscriber to sign up.
//
// The bearer-gated /api/appstle/* routes are NOT touched: they are called
// directly by ln_reward_sync.py, never through the App Proxy, so nothing masks
// their 5xx and a 5xx is the honest answer there.
function upstreamFailure(res, label, error, message) {
    const upstream = error && error.response && error.response.data;
    console.error(
        `proxy/${label} error:`,
        (error && error.response && error.response.status) || "",
        typeof upstream === "object" ? JSON.stringify(upstream) : (upstream || (error && error.message))
    );
    return res.status(409).json({
        ok: false,
        error: message,
        details: upstream || (error && error.message),
    });
}

// GET box → { subscribed, contractId?, status?, skus[] }
// Hydrates the bookshelf's amber "in your next box" chips.
async function boxHandler(req, res) {
    try {
        const contract = await getContractForCustomer(req.customerId);
        if (!contract) return res.status(200).json({ subscribed: false, skus: [] });

        const url = `https://subscription-admin.appstle.com/api/external/v2/subscription-contract-details?subscriptionContractId=${contract.id}&page=0&size=10&sort=id,desc`;
        const details = await axios.get(url, {
            headers: { "X-API-Key": APPSTLE_API_KEY, "Content-Type": "application/json" },
        });

        const rows = Array.isArray(details.data) ? details.data : [];
        rows.forEach((item) => {
            ["contractDetailsJSON", "orderNoteAttributes", "lastSuccessfulOrder"].forEach((f) => {
                if (typeof item[f] === "string") {
                    try { item[f] = JSON.parse(item[f]); } catch (e) { /* leave as-is */ }
                }
            });
        });

        const skus = Array.from(new Set(collectSkus(rows)));
        res.status(200).json({ subscribed: true, contractId: contract.id, status: contract.status, skus });
    } catch (error) {
        return upstreamFailure(res, "box", error, "Failed to read box.");
    }
}

// POST add  { variantId, quantity? } → adds a ONE-TIME item to the logged-in
// customer's own next box. isOneTimeProduct is hardcoded true.
// Shopify rejects a subscription-draft commit that collided with another edit
// on the same contract: STALE_CONTRACT, "Another operation updated the contract
// concurrently as the commit was in progress." Appstle surfaces Shopify's own
// constraint errors as 422 with the reason in the body.
//
// Catch Up on My Library fires up to NINE adds at ONE contract a few hundred ms
// apart, which is precisely that collision, and the symptom matches: one volume
// out of nine fails while its neighbours succeed, at a different position every
// run (Vol 4, then Vol 2, then Vol 3).
//
// THIS IS THE ONLY ADD FAILURE THAT IS SAFE TO RETRY, and that is the whole
// reason the retry is this narrow. STALE_CONTRACT means the commit was
// REJECTED, so the line item did NOT land and re-sending cannot add it twice.
// Every other failure is ambiguous — the write may have applied and only the
// response been lost — and a blind retry there would double-charge a customer.
// Those still fail through to the client untouched.
//
// Matched on the RESPONSE BODY only, never on error.message: a client-side
// axios timeout is exactly the ambiguous case this must not touch.
// A contract write runs INSIDE a Shopify App Proxy request, so the whole
// handler shares one upstream budget. Retrying is only worth anything if the
// retry still lands inside it, hence RETRY_BUDGET_MS: a wait is only taken if
// there is room for it. Nothing here retries a slow failure into a timeout.
//
// TWO FAILURES ARE WORTH RESENDING, AND THEY NEED DIFFERENT PATIENCE.
//
// 1. CONFLICT (2026-09-06). Captured from a real box-remove:
//
//      { entityName: 'subscriptionContractDetails', errorKey: '10001',
//        status: 400,
//        message: 'UserGeneratedError:An unexpected error occurred:
//                  The subscription contract has changed.' }
//
//    Appstle NEVER says "STALE_CONTRACT" — it says "the subscription contract
//    has changed", and answers 400, not the 422 its docs imply. An earlier
//    predicate matched Shopify's vocabulary instead and never fired once.
//    This arrives AFTER a full write attempt (~2.5-5s), so one patient retry
//    is all that fits.
//
// 2. RATE LIMIT (2026-09-06). Clearing 24 add-ons produced 16 of these:
//
//      429 {"error":"Rate limit exceeded. Try again later."}
//      429 {"error":"Too many concurrent mutation requests.
//                    Please wait for existing requests to complete."}
//
//    These come back in ~80ms, so they are cheap to sit out — but a single
//    700ms wait loses to a rate limiter, which is exactly what happened. They
//    get three tries with a widening wait instead.
//
// BOTH ARE SAFE TO RESEND, and that is why the classifier is this narrow. A
// conflict means the commit was REJECTED and a 429 means the request was never
// processed, so in neither case did the write land. Every other failure is
// ambiguous — it may have applied with only the response lost — and a blind
// retry there would double-charge. Those fail through untouched.
//
// Classified on the RESPONSE only, never on error.message: a client-side axios
// timeout is precisely the ambiguous case this must not touch.
const RETRY_BUDGET_MS = 6000;
const CONFLICT_WAITS_MS = [700];              // one patient retry
const RATE_LIMIT_WAITS_MS = [300, 900, 2700]; // three impatient ones

function classifyRetryable(error) {
    if (error && error.response && error.response.status === 429) return "rate limit";
    const data = error && error.response && error.response.data;
    let body = typeof data === "string" ? data : "";
    if (data && typeof data === "object") {
        try { body = JSON.stringify(data); } catch (e) { body = ""; }
    }
    if (/subscription contract has changed/i.test(body)
        || /"errorKey"\s*:\s*"10001"/i.test(body)
        || /STALE_CONTRACT|concurrently as the commit was in progress/i.test(body)) {
        return "conflict";
    }
    return null;
}

// One Appstle contract write, resent only on the two failures above.
// Returns { response, attempts, ms }; throws the last error if it runs out.
async function contractPut(url, headers, label) {
    const startedAt = Date.now();
    let lastError = null;
    for (let attempt = 1; ; attempt++) {
        try {
            const response = await axios.put(url, {}, { headers });
            if (attempt > 1) console.warn(`${label}: recovered on attempt ${attempt}.`);
            return { response, attempts: attempt, ms: Date.now() - startedAt };
        } catch (error) {
            lastError = error;
            const kind = classifyRetryable(error);
            if (!kind) break;
            const waits = kind === "rate limit" ? RATE_LIMIT_WAITS_MS : CONFLICT_WAITS_MS;
            const wait = waits[attempt - 1];
            const elapsed = Date.now() - startedAt;
            if (wait === undefined || elapsed + wait > RETRY_BUDGET_MS) break;
            console.warn(`${label}: ${kind} at ${elapsed}ms, retry ${attempt} in ${wait}ms.`);
            await new Promise((r) => setTimeout(r, wait));
        }
    }
    throw lastError;
}

async function addToBoxHandler(req, res) {
    req._addStartedAt = Date.now();
    const rawVariant = String((req.body || {}).variantId || "");
    const variantId = rawVariant.replace(/^gid:\/\/shopify\/ProductVariant\//, "");
    if (!/^\d+$/.test(variantId)) {
        return res.status(400).json({ error: "Invalid variantId." });
    }
    const quantity = parseInt((req.body || {}).quantity, 10) || 1;
    if (quantity < 1 || quantity > 5) {
        return res.status(400).json({ error: "Invalid quantity." });
    }

    try {
        const contract = await getContractForCustomer(req.customerId);
        if (!contract) return res.status(403).json({ error: "No active subscription." });

        const url = `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts-add-line-item?contractId=${contract.id}&quantity=${quantity}&variantId=${variantId}&isOneTimeProduct=true`;
        const headers = { "X-API-Key": APPSTLE_API_KEY, "Content-Type": "application/json" };

        // `attempts` and `ms` are diagnostics, not decoration. A recovered
        // write is otherwise indistinguishable from a slow one, and the only
        // place that recorded the difference was a Vercel log nobody could
        // reach. `attempts: 2` on a real run is what finally proved the retry
        // fires and that it does not double-add.
        const { response, attempts, ms } = await contractPut(url, headers, `proxy/add-line-item variant ${variantId}`);
        return res.status(200).json({
            ok: true,
            contractId: contract.id,
            attempts,
            ms,
            data: response.data,
        });
    } catch (error) {
        // Log the WHOLE upstream body. This is the only place the real reason
        // exists — the client only ever sees a flat 502 — and three dropped
        // volumes in a row were undiagnosable because nobody could read it.
        const upstream = error.response?.data;
        console.error(
            "proxy/add-line-item error:",
            error.response?.status || "",
            `${Date.now() - (req._addStartedAt || Date.now())}ms`,
            typeof upstream === "object" ? JSON.stringify(upstream) : (upstream || error.message)
        );
        // 409, NOT 502, AND THE STATUS IS THE WHOLE POINT.
        //
        // /box-add is only reachable through Shopify's App Proxy, and Shopify
        // REPLACES the body of any 5xx with its own themed storefront error
        // page. Captured from a real failed run on 6 Sep 2026, the browser got:
        //
        //   proxy 500 <!doctype html><html class="js" lang="en"> ... LayoutHub
        //
        // -- our JSON, and `details` with it, was gone. That is the same trap
        // #3 fixed for /owned. Five dropped volumes were undiagnosable because
        // of it: the client was logging a status Shopify had rewritten and a
        // body Shopify had thrown away.
        //
        // A 4xx passes through the App Proxy UNTOUCHED — verified against this
        // same route family, where /box-details' 401 arrives intact. So the
        // reason now reaches the client, which already logs the body.
        //
        // 409 rather than 200: the client treats any non-2xx as a failed
        // volume, which is correct and must not change. Returning 200 the way
        // /owned does would silently mark failed volumes as added.
        res.status(409).json({
            ok: false,
            error: "Failed to add to box.",
            ms: Date.now() - (req._addStartedAt || Date.now()),
            details: upstream || error.message,
        });
    }
}

// "Honsama's Monthly Manga Box" product + its 2-Manga variant. Box billing
// orders carry only the box line item (no per-manga SKUs), so the bookshelf
// credits the featured manga from these order months + the store's box_month
// metaobject entries.
var BOX_PRODUCT_ID = "8150096773420";        // reference only - see boxTier()
var BOX_VARIANT_2MANGA_ID = "52361633005868"; // reference only - see boxTier()

// WHICH BOX TIER IS THIS ORDER LINE, IF ANY? "2" | "3" | null.
//
// THIS USED TO READ li.product.id AND li.variant.id, AND THAT IS WHY /owned HAS
// ANSWERED {available:false} SINCE 19 JULY 2026. Those two object references
// need the `read_products` scope, which this app has never requested - its
// OAuth list is read_orders, read_all_orders, write_orders, read_customers,
// write_customers. The Admin API answered:
//
//   Access denied for product field. Required access: `read_products`
//   path: customer.orders.nodes[12].lineItems.nodes[0].variant
//   ... Too many execution errors, max error limit reached. Results truncated
//
// Orders themselves read fine; only the joins were denied. #3 later made the
// route degrade quietly instead of 5xx-ing, which stopped the 675KB-per-view
// bleed and also stopped anyone noticing for six weeks.
//
// SKU, TITLE AND VARIANT TITLE ARE DENORMALISED ONTO THE ORDER LINE and need no
// extra scope, so the same question is answered without the joins. Verified on
// real orders 6 Sep 2026: box lines carry sku MMB-3, title "Honsama's Monthly
// Manga Box", variantTitle "3 Manga"; the product has exactly two variants,
// MMB-3 "3 Manga" and MMB-2 "2 Manga".
//
// SKU FIRST, TITLE AS THE FALLBACK. SKUs on this store are hand-entered and
// have been malformed before, which is why the title path exists at all - but a
// line with a broken SKU still carries the product title Shopify copied onto it
// at purchase. Renaming the product would break the fallback, not the primary.
// MATCHED AS A SUBSTRING, NOT AN EQUALITY, BECAUSE THE PRODUCT WAS RENAMED.
// The oldest orders on this store carry "Honsama's NEWLY RELEASED Monthly Manga
// Box" (e.g. #honsama1001, May 2024) and their line items have LOST THEIR SKU -
// sku is "" and variantTitle is null. An exact-title test dropped that box
// entirely: measured on a 28-order subscriber, exact matched 27/28 while the
// substring matched 28/28. Shopify snapshots the title onto the line at
// purchase, so a future rename creates the same silent hole - keep this loose.
var BOX_TITLE_FRAGMENT = "monthly manga box";

function boxTier(li) {
    var sku = String((li && li.sku) || "").trim().toUpperCase();
    if (sku === "MMB-2") return "2";
    if (sku === "MMB-3") return "3";
    if (String((li && li.title) || "").toLowerCase().indexOf(BOX_TITLE_FRAGMENT) === -1) return null;
    // Same fallback ORDER the Liquid uses, because line items lose different
    // identifiers over time: sku, then the variant, then PRICE. `variant_id`
    // is not reachable without read_products, so variantTitle stands in for it.
    var vt = String((li && li.variantTitle) || "").trim();
    if (vt.indexOf("2") === 0) return "2";
    if (vt.indexOf("3") === 0) return "3";
    // PRICE LAST, and only on a positive amount. MMB-3 has always billed 34.99
    // or 36.99 and MMB-2 26.99, with nothing between. A $0.00 box line is real
    // in this store's history (comped rebills) and must NOT read as 2-manga.
    var amt = parseFloat(li && li.originalUnitPriceSet && li.originalUnitPriceSet.shopMoney
        && li.originalUnitPriceSet.shopMoney.amount);
    if (isFinite(amt) && amt > 0) return amt < 34 ? "2" : "3";
    return "3";
}

// SHIP MONTH FROM THE FULFILMENT DATE, in SHOP time.
//
// Boxes ship in ONE BATCH per month landing between roughly the 25th and the
// 2nd, so a fulfilment on day >= 15 belongs to NEXT month's box; below that, to
// this month's. Verified 15/15 across two customers, Jan 2025 - Jun 2026, when
// the Liquid was rewritten on 29 Aug 2026.
//
// SHOP TIME MATTERS: #HONSAMA3768 fulfilled at 2026-04-01T04:00:22Z, which is
// 2026-03-31 21:00 in Los Angeles. The Liquid reads a shop-local timestamp, so
// this has to as well or the two drift for any late-evening fulfilment.
var SHOP_TZ = "America/Los_Angeles";

function shipMonthFromFulfilment(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    var parts = {};
    new Intl.DateTimeFormat("en-CA", {
        timeZone: SHOP_TZ, year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(d).forEach(function (p) { parts[p.type] = p.value; });
    var y = parseInt(parts.year, 10);
    var m = parseInt(parts.month, 10);
    var day = parseInt(parts.day, 10);
    if (!y || !m || !day) return null;
    var midx = (m - 1) + (day >= 15 ? 1 : 0);
    return `${y + Math.floor(midx / 12)}-${String((midx % 12) + 1).padStart(2, "0")}`;
}

// GET owned → { available, skus[], orders, boxMonths[], boxMonths2[] } — the
// customer's FULL order history.
// Storefront Liquid's customer.orders loop caps at ~50 orders, so heavy buyers'
// shelves would silently truncate; this walks every order via the Admin API
// (store-owned token with read_all_orders has no 60-day window). The bookshelf
// uses Liquid data for first paint and swaps in this authoritative list.
async function ownedHandler(req, res) {
    if (!ADMIN_API_TOKEN) {
        // Not configured yet — tell the client to keep its Liquid-rendered data.
        return res.status(200).json({ available: false, skus: [] });
    }
    try {
        const skus = [];
        const boxMonths = new Set();   // "YYYY-MM" box months billed (3-Manga / default)
        const boxMonths2 = new Set();  // ... billed on the 2-Manga variant
        let after = null;
        let orderCount = 0;
        // 100 orders/page, 30-page guard = 3000 orders — far beyond any customer.
        // lineItems capped at 100/order (a manga box order has <20 lines).
        for (let page = 0; page < 30; page++) {
            const response = await axios.post(
                `https://${SHOP_DOMAIN}/admin/api/2025-10/graphql.json`,
                {
                    query: `query Owned($id: ID!, $after: String) {
                        customer(id: $id) {
                            orders(first: 100, after: $after) {
                                pageInfo { hasNextPage endCursor }
                                nodes {
                                    createdAt
                                    cancelledAt
                                    displayFulfillmentStatus
                                    fulfillments(first: 1) { createdAt }
                                    lineItems(first: 100) {
                                        nodes {
                                            sku title variantTitle
                                            originalUnitPriceSet { shopMoney { amount } }
                                        }
                                    }
                                }
                            }
                        }
                    }`,
                    variables: { id: `gid://shopify/Customer/${req.customerId}`, after },
                },
                { headers: { "X-Shopify-Access-Token": ADMIN_API_TOKEN, "Content-Type": "application/json" } }
            );
            if (response.data.errors) throw new Error(JSON.stringify(response.data.errors));
            const orders = response.data?.data?.customer?.orders;
            if (!orders) break; // unknown customer id → empty history
            orders.nodes.forEach((o) => {
                orderCount++;
                // ONLY A FULFILLED ORDER CREDITS A BOX MONTH, and the month comes
                // from the FULFILMENT date. This is not a detail: it is the rule
                // sections/honsama-my-library.liquid uses, and /owned overrides
                // the Liquid whenever `available` is true. The previous version
                // had NEITHER - it credited every order from its BILLING date,
                // so on the test account it would have claimed ~8 months against
                // the Liquid's 2 and told customers they owned manga that was
                // billed but never shipped.
                const fulfilledAt = o.displayFulfillmentStatus === "FULFILLED"
                    && o.fulfillments && o.fulfillments[0] && o.fulfillments[0].createdAt;
                const month = fulfilledAt ? shipMonthFromFulfilment(fulfilledAt) : null;
                // A CANCELLED ORDER THAT NEVER SHIPPED IS NOT A PURCHASE, and its
                // SKUs were being collected anyway: the push below was the one line
                // in this handler with no gate on it, and the query did not even ask
                // for cancelledAt, so a cancellation was invisible here.
                //
                // Found 9 Sep 2026. Ricky took the $1 Kindergarten Wars with his first
                // box on the redesign theme and cancelled eleven minutes later - order
                // #HONSAMA4314, no fulfilment at all, nothing picked or posted - and the
                // volume stayed on his shelf. The same fix landed in
                // snippets/hn-owned-data.liquid first and changed nothing a customer
                // could see, because THIS ROUTE OVERRIDES that Liquid whenever available
                // is true. Fixing the theme alone cannot fix this page; if you are
                // reading that Liquid guard and wondering why it has no effect, this is
                // why.
                //
                // ORDER-LEVEL, NOT PER LINE, unlike the Liquid, and deliberately. The
                // Liquid can ask each line whether it shipped; the only honest signal
                // here is whether the ORDER carries any fulfilment, because
                // unfulfilledQuantity is not trustworthy on a cancelled order - on
                // #HONSAMA4314 the cancelled Kindergarten Wars line reported
                // unfulfilledQuantity 0 while nothing had ever been picked.
                //
                // So: cancelled AND no fulfilment means nothing shipped, drop it.
                // Cancelled WITH a fulfilment keeps everything, erring toward the
                // customer keeping what they may physically hold - the same direction
                // the fulfilled-order rule above already errs.
                const cancelledUnshipped = !!o.cancelledAt
                    && !(o.fulfillments && o.fulfillments.length);
                (o.lineItems?.nodes || []).forEach((li) => {
                    if (li.sku && !cancelledUnshipped) skus.push(li.sku);
                    const tier = boxTier(li);
                    if (!tier || !month) return;   // unshipped box credits nothing
                    if (tier === "2") boxMonths2.add(month);
                    else boxMonths.add(month);
                });
            });
            if (!orders.pageInfo.hasNextPage) break;
            after = orders.pageInfo.endCursor;
        }
        // Fold in what the customer has told us they own. Read failures are
        // non-fatal: a shelf short of a declaration is a far smaller problem
        // than a shelf that fails to load, and the client keeps its Liquid
        // data if this route errors entirely.
        let declared = [];
        try {
            const d = await readFollowing(req.customerId, OWNED_METAFIELD);
            declared = d.keys || [];
        } catch (e) {
            console.warn("proxy/owned: declarations unavailable:", e.message);
        }

        res.status(200).json({
            available: true,
            orders: orderCount,
            skus: applyDeclarations(Array.from(new Set(skus)), declared),
            boxMonths: Array.from(boxMonths).sort(),
            boxMonths2: Array.from(boxMonths2).sort(),
        });
    } catch (error) {
        // FAIL SOFT - NEVER RETURN A 5xx FROM THIS ROUTE.
        //
        // This endpoint is only ever reached through Shopify's App Proxy, and
        // Shopify REPLACES an upstream 5xx with its own storefront error page.
        // Measured on 28 Aug 2026 while this returned 502: every My Library
        // page load pulled 675KB of HTML from /apps/appstle-proxy/owned and
        // threw it away. The endpoint failed in a way that cost real bandwidth
        // on every view instead of failing quietly.
        //
        // Degrading to `available:false` is already the contract for the
        // not-configured case a few lines above, and the client is built for
        // it: the bookshelf adopts this response only when `available` is true
        // AND the list is non-empty, so it keeps its Liquid-rendered order
        // history untouched. That fallback is correct, just capped at roughly
        // 50 orders - and that is what a broken or under-scoped ADMIN_API_TOKEN
        // should cost: one log line, not 675KB per page view.
        //
        // The console.error is the diagnostic. If a shelf is silently capped,
        // read it - it carries the Admin API's own message, which distinguishes
        // an expired token from a missing read_all_orders scope.
        console.error("proxy/owned error:", error.response?.data || error.message);
        res.status(200).json({ available: false, skus: [] });
    }
}

// ---- Follow a series (signed, own-customer-only) -------------------------
// POST follow / POST unfollow { seriesKey } — toggles a series in the
// customer's `honsama.following` metafield (list.single_line_text_field of
// canonical seriesKeys, e.g. "M-SS-GSTWL"). The client derives the key with
// the collection engine's parseSku (SKU/series aliases applied), so the
// server only validates shape. Reads need read_customers; WRITES need
// write_customers — re-run /auth if metafieldsSet returns an access error.

var SERIES_KEY_RE = /^[A-Z]+-[A-Z]+-[A-Z0-9&]+$/;
var FOLLOW_METAFIELD = { namespace: "honsama", key: "following" };
// Favorites (pin-to-top-of-library) use the exact same mechanics on a
// sibling metafield — same list type, same seriesKey values.
var FAVORITES_METAFIELD = { namespace: "honsama", key: "favorites" };
var FOLLOW_CAP = 300; // sanity ceiling; nobody follows 300 series

// ---- customer-declared ownership (My Library) --------------------------
// Spec: HonsamaOps/Honsama Library Ownership/OWNERSHIP_SPEC.md
//
// The shelf otherwise shows only what someone bought FROM Honsama, so a
// collector who already owns volumes opens on a wall of gaps and is then sold
// volumes they have. These entries let them say so.
//
// Two entry shapes, stored in one list metafield:
//   "M-KD-TFFBD:8:1757380000"     claim     - I own up to Vol 8
//   "-M-KD-TFFBD-02:1757380000"   exception - except Vol 2
//
// ADDITIVE ONLY, AND THAT IS ENFORCED BY THE CODE, NOT BY THE UI. A
// declaration can never remove a volume Honsama shipped: applyDeclarations
// below only ever PUSHES, so there is no path through it that drops a SKU
// derived from an order. A general "remove this title" was specced and cut on
// 9 Sep 2026 (Ricky: "dont let them hide a series"); the customer can retract
// their OWN entry, which is a different thing and leaves purchased volumes
// standing.
//
// NO TIMESTAMP PRECEDENCE, deliberately. An earlier draft of the spec had
// "most recent fact wins" so a later purchase could beat an older exception.
// It is unnecessary once exceptions only ever suppress a CLAIMED volume:
// a purchase always wins because the exception never reaches it. The
// timestamp is retained in the stored value for support and display only, and
// nothing reads it. Keeping it out of the comparison is also what lets the
// Liquid fallback implement identical rules without doing date maths.
var OWNED_METAFIELD = { namespace: "honsama", key: "owned_upto" };
var OWNED_CAP = 600;      // claims + exceptions across every series
// 200 rather than 999 because the LIQUID FALLBACK has to loop this range to
// synthesise the claimed SKUs, and the two paths must apply identical rules.
// 600 x 999 iterations would be a real cost on a page render; 600 x 200 is
// survivable, and the longest series in the catalogue is 14 volumes, so the
// ceiling is unreachable in practice by anyone acting in good faith.
var OWNED_MAX_VOL = 200;
var CLAIM_RE = /^([A-Z]+-[A-Z]+-[A-Z0-9&]+):(\d{1,3}):(\d{1,13})$/;
var EXCEPT_RE = /^-([A-Z]+-[A-Z]+-[A-Z0-9&]+)-(\d{1,3}):(\d{1,13})$/;

// Volume SKUs are zero-padded to two digits ("-01"), and wider only past 99,
// which is how every SKU in the catalogue is shaped.
function volSku(seriesKey, n) {
    return seriesKey + "-" + (n < 10 ? "0" + n : String(n));
}

function parseDeclarations(entries) {
    var claims = {}, exceptions = {};
    (entries || []).forEach(function (raw) {
        var v = String(raw || "").trim().toUpperCase();
        var m = CLAIM_RE.exec(v);
        if (m) {
            var n = parseInt(m[2], 10);
            // Highest claim wins if the list somehow carries two for one
            // series; the write path replaces rather than appends, so this is
            // belt and braces against a partial write.
            if (!claims[m[1]] || n > claims[m[1]]) claims[m[1]] = n;
            return;
        }
        m = EXCEPT_RE.exec(v);
        if (m) exceptions[volSku(m[1], parseInt(m[2], 10))] = true;
    });
    return { claims: claims, exceptions: exceptions };
}

// Returns a NEW array. Never removes: see the additive-only note above.
function applyDeclarations(skus, entries) {
    var d = parseDeclarations(entries);
    var out = (skus || []).slice();
    var have = {};
    out.forEach(function (x) { have[String(x || "").toUpperCase()] = true; });
    Object.keys(d.claims).forEach(function (key) {
        var upTo = Math.min(d.claims[key], OWNED_MAX_VOL);
        for (var n = 1; n <= upTo; n++) {
            var sku = volSku(key, n);
            if (d.exceptions[sku]) continue;  // they say they do not have this one
            if (have[sku]) continue;          // already owned from an order
            out.push(sku);
            have[sku] = true;
        }
    });
    return out;
}

async function adminGraphql(query, variables) {
    const response = await axios.post(
        `https://${SHOP_DOMAIN}/admin/api/2025-10/graphql.json`,
        { query, variables },
        { headers: { "X-Shopify-Access-Token": ADMIN_API_TOKEN, "Content-Type": "application/json" } }
    );
    if (response.data.errors) throw new Error(JSON.stringify(response.data.errors));
    return response.data.data;
}

// Returns { keys, digest }. The digest is Shopify's optimistic-concurrency
// token for this metafield — hand it back on the write and the mutation is
// rejected if anything else changed the value in between. See the race note
// on seriesListToggleHandler.
async function readFollowing(customerId, mf) {
    mf = mf || FOLLOW_METAFIELD;
    const data = await adminGraphql(
        `query Following($id: ID!) {
            customer(id: $id) {
                metafield(namespace: "${mf.namespace}", key: "${mf.key}") { value compareDigest }
            }
        }`,
        { id: `gid://shopify/Customer/${customerId}` }
    );
    const field = data?.customer?.metafield;
    const digest = field?.compareDigest || null;
    const raw = field?.value;
    if (!raw) return { keys: [], digest: digest };
    try {
        const list = JSON.parse(raw);
        return {
            keys: Array.isArray(list) ? list.filter((k) => typeof k === "string") : [],
            digest: digest,
        };
    } catch (e) { return { keys: [], digest: digest }; }
}

// Returns true on success, false if the metafield changed under us
// (STALE_OBJECT) so the caller can re-read and retry. Any other userError is
// still thrown — a conflict is routine, a validation failure is not.
//
// `digest` is omitted when the metafield does not exist yet: there is nothing
// to compare against on a first write. Two simultaneous FIRST writes for the
// same customer can therefore still clobber each other, which is the one gap
// this leaves. It needs a customer with zero follows tapping two hearts in the
// same instant, and the loser is one entry rather than the whole list.
async function writeFollowing(customerId, keys, mf, digest) {
    mf = mf || FOLLOW_METAFIELD;
    const entry = {
        ownerId: `gid://shopify/Customer/${customerId}`,
        namespace: mf.namespace,
        key: mf.key,
        type: "list.single_line_text_field",
        value: JSON.stringify(keys),
    };
    if (digest) entry.compareDigest = digest;
    const data = await adminGraphql(
        `mutation SetFollowing($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
                metafields { id }
                userErrors { field message code }
            }
        }`,
        { metafields: [entry] }
    );
    const errs = data?.metafieldsSet?.userErrors || [];
    if (!errs.length) return true;
    if (errs.some((e) => e.code === "STALE_OBJECT")) return false;
    throw new Error(JSON.stringify(errs));
}

// Shared toggle: add=true → follow/favorite, add=false → un-. Idempotent —
// the response always reflects the resulting list, so the client can re-sync.
//
// THIS USED TO LOSE WRITES, AND IT WAS OBSERVED IN THE WILD (28 Aug 2026).
// It was a plain read-modify-write: read the list, change one entry, then
// metafieldsSet the WHOLE list back. metafieldsSet is a full replace, so two
// requests overlapping anywhere in that window both read the old list and the
// second one silently discards the first one's entry. Two favourites vanished
// from a real customer's metafield this way; two toggles ~1.2s apart were
// enough, because a Shopify Admin round trip plus a cold Vercel start is
// easily wider than that.
//
// The fix is Shopify's own optimistic-concurrency token: read compareDigest
// alongside the value, pass it back on the write, and the mutation is rejected
// with STALE_OBJECT if anything changed in between. Verified against the live
// API before writing this: a stale digest returns
// "The resource has been updated since it was loaded."
//
// On conflict we RE-READ and retry rather than fail, so the caller still gets
// the outcome it asked for. Retries are bounded and backed off; exhausting
// them returns 409 (retry-able) rather than 502 (broken), because the request
// was valid and the client is safe to send it again.
const TOGGLE_ATTEMPTS = 4;

function seriesListToggleHandler(add, mf, verb) {
    return async function (req, res) {
        const seriesKey = String((req.body || {}).seriesKey || "").trim().toUpperCase();
        if (!SERIES_KEY_RE.test(seriesKey) || seriesKey.length > 32) {
            return res.status(400).json({ error: "Invalid seriesKey." });
        }
        if (!ADMIN_API_TOKEN) {
            return res.status(503).json({ error: `${verb} is not configured yet.` });
        }
        try {
            for (let attempt = 1; attempt <= TOGGLE_ATTEMPTS; attempt++) {
                const { keys, digest } = await readFollowing(req.customerId, mf);
                const has = keys.indexOf(seriesKey) !== -1;

                // Already in the desired state — nothing to write, and no race
                // to lose. Return the list so the client can re-sync anyway.
                if (add === has) return res.status(200).json({ ok: true, [mf.key]: keys });

                const next = add ? keys.concat([seriesKey]) : keys.filter((k) => k !== seriesKey);
                if (next.length > FOLLOW_CAP) {
                    return res.status(400).json({ error: `Too many ${mf.key} series.` });
                }

                if (await writeFollowing(req.customerId, next, mf, digest)) {
                    return res.status(200).json({ ok: true, [mf.key]: next });
                }

                // Someone else wrote first. Re-read and rebuild from THEIR list
                // rather than replaying ours, which is the whole point.
                console.warn(`proxy/${verb.toLowerCase()}: stale metafield, retry ${attempt}/${TOGGLE_ATTEMPTS}`);
                await new Promise((r) => setTimeout(r, 80 * attempt));
            }
            res.status(409).json({ error: `${verb} is busy, please try again.` });
        } catch (error) {
            return upstreamFailure(
                res,
                `${add ? "" : "un"}${verb.toLowerCase()}`,
                error,
                `Failed to ${add ? "" : "un"}${verb.toLowerCase()}.`
            );
        }
    };
}
// POST owned-declare — set a claim, set/clear exceptions, or retract.
//   { seriesKey, upTo }            "I own up to Vol N"  (upTo 0 clears it)
//   { seriesKey, upTo, except:[] } ...and the volumes in that run they do NOT
//                                  have. Replaces the whole exception set for
//                                  the series, so it is one atomic write.
//   { seriesKey, volume, owned }   set (owned:false) or clear (owned:true) one
//   { seriesKey, retract:true }    delete this customer's own entries
//
// `except` EXISTS BECAUSE COLLECTIONS ARE NOT ALWAYS CONTIGUOUS. Ricky,
// 9 Sep 2026: "If i owned vol 2 of 100 ghost stories. I can't select only
// that." Owning Vol 2 alone is upTo:2 with except:[1]. Sending the claim and
// its exceptions as separate requests would work, but a failure between them
// leaves a shelf claiming volumes the customer just said they do not have -
// so they travel together and are written once.
//
// Same optimistic-concurrency dance as the follow/favourite toggles: read the
// list with its compareDigest, rebuild, write it back, and re-read on
// STALE_OBJECT rather than replaying a stale list. See the long note on
// seriesListToggleHandler for why that matters - two writes 1.2s apart were
// enough to lose a real customer's data before it was added.
//
// IT ONLY EVER TOUCHES THE METAFIELD. Nothing here can remove a SKU derived
// from an order, which is what makes "retract" safe to expose: the worst it
// can do is delete the customer's own claim and leave what was shipped.
async function ownedDeclareHandler(req, res) {
    const body = req.body || {};
    const seriesKey = String(body.seriesKey || "").trim().toUpperCase();
    if (!SERIES_KEY_RE.test(seriesKey) || seriesKey.length > 32) {
        return res.status(400).json({ error: "Invalid seriesKey." });
    }
    if (!ADMIN_API_TOKEN) {
        return res.status(503).json({ error: "Library editing is not configured yet." });
    }

    const retract = body.retract === true;
    const hasUpTo = Object.prototype.hasOwnProperty.call(body, "upTo");
    const hasVolume = Object.prototype.hasOwnProperty.call(body, "volume");
    const hasExcept = Array.isArray(body.except);
    const upTo = hasUpTo ? parseInt(body.upTo, 10) : null;
    const volume = hasVolume ? parseInt(body.volume, 10) : null;
    const owned = body.owned !== false;   // default true = clear the exception
    const except = hasExcept
        ? body.except.map(function (v) { return parseInt(v, 10); })
        : [];

    if (!retract && !hasUpTo && !hasVolume) {
        return res.status(400).json({ error: "Nothing to change." });
    }
    if (hasUpTo && (!Number.isInteger(upTo) || upTo < 0 || upTo > OWNED_MAX_VOL)) {
        return res.status(400).json({ error: "Invalid upTo." });
    }
    if (hasVolume && (!Number.isInteger(volume) || volume < 1 || volume > OWNED_MAX_VOL)) {
        return res.status(400).json({ error: "Invalid volume." });
    }
    if (hasExcept) {
        if (!hasUpTo) {
            return res.status(400).json({ error: "except needs upTo." });
        }
        if (except.length > OWNED_MAX_VOL) {
            return res.status(400).json({ error: "Too many exceptions." });
        }
        for (let i = 0; i < except.length; i++) {
            // Outside the claimed run an exception has nothing to suppress -
            // it cannot reach a purchased volume - so reject rather than
            // silently store an entry that will never do anything.
            if (!Number.isInteger(except[i]) || except[i] < 1 || except[i] > upTo) {
                return res.status(400).json({ error: "Invalid exception volume." });
            }
        }
    }

    try {
        for (let attempt = 1; attempt <= TOGGLE_ATTEMPTS; attempt++) {
            const { keys, digest } = await readFollowing(req.customerId, OWNED_METAFIELD);
            const ts = Math.floor(Date.now() / 1000);

            // Drop whatever this request supersedes, then re-add. Replace
            // rather than append, so a series can never accumulate two claims.
            const next = keys.filter(function (raw) {
                const v = String(raw || "").trim().toUpperCase();
                const c = CLAIM_RE.exec(v);
                const e = EXCEPT_RE.exec(v);
                if (retract) {
                    return !((c && c[1] === seriesKey) || (e && e[1] === seriesKey));
                }
                if (hasUpTo && c && c[1] === seriesKey) return false;
                // Replacing the set wholesale: drop every exception for this
                // series, then re-add exactly what came in.
                if (hasExcept && e && e[1] === seriesKey) return false;
                if (hasVolume && e && e[1] === seriesKey && parseInt(e[2], 10) === volume) return false;
                return true;
            });

            if (!retract) {
                if (hasUpTo && upTo > 0) next.push(seriesKey + ":" + upTo + ":" + ts);
                if (hasExcept && upTo > 0) {
                    except.forEach(function (v) {
                        next.push("-" + volSku(seriesKey, v) + ":" + ts);
                    });
                }
                if (hasVolume && !owned) next.push("-" + volSku(seriesKey, volume) + ":" + ts);
            }

            if (next.length > OWNED_CAP) {
                return res.status(400).json({ error: "Too many library entries." });
            }

            if (await writeFollowing(req.customerId, next, OWNED_METAFIELD, digest)) {
                return res.status(200).json({ ok: true, owned_upto: next });
            }

            console.warn(`proxy/owned-declare: stale metafield, retry ${attempt}/${TOGGLE_ATTEMPTS}`);
            await new Promise((r) => setTimeout(r, 80 * attempt));
        }
        res.status(409).json({ error: "Library is busy, please try again." });
    } catch (error) {
        return upstreamFailure(res, "owned-declare", error, "Failed to save your library.");
    }
}

function followToggleHandler(add) { return seriesListToggleHandler(add, FOLLOW_METAFIELD, "Follow"); }
function favoriteToggleHandler(add) { return seriesListToggleHandler(add, FAVORITES_METAFIELD, "Favorite"); }

// ---- Drawer operations, signed + own-contract-only ----------------------
// These four port the cart drawer off the unauthenticated legacy routes.
// The client NEVER sends a contractId — it's resolved server-side from the
// signed logged_in_customer_id, so a customer can only ever act on their own
// subscription. (Remove/skip/discount are fine to expose here: this is the
// same authority the Appstle portal widget already gives the customer.)

// GET box-details → { subscribed, contractId?, details:[rows] } — the parsed
// contract rows the drawer renders (titles, images, prices, lineIds, dates).
async function boxDetailsHandler(req, res) {
    try {
        const contract = await getContractForCustomer(req.customerId);
        if (!contract) return res.status(200).json({ subscribed: false, details: [] });

        const url = `https://subscription-admin.appstle.com/api/external/v2/subscription-contract-details?subscriptionContractId=${contract.id}&page=0&size=10&sort=id,desc`;
        const response = await axios.get(url, {
            headers: { "X-API-Key": APPSTLE_API_KEY, "Content-Type": "application/json" },
        });
        const rows = Array.isArray(response.data) ? response.data : [];
        rows.forEach((item) => {
            ["contractDetailsJSON", "orderNoteAttributes", "lastSuccessfulOrder"].forEach((f) => {
                if (typeof item[f] === "string") {
                    try {
                        item[f.replace("JSON", "")] = JSON.parse(item[f]);
                        if (f === "contractDetailsJSON") item.contractDetails = JSON.parse(item[f]);
                    } catch (e) { /* leave as-is */ }
                }
            });
        });
        res.status(200).json({ subscribed: true, contractId: contract.id, details: rows });
    } catch (error) {
        return upstreamFailure(res, "box-details", error, "Failed to read box details.");
    }
}

// POST box-remove { lineId } — remove a line from the customer's own contract.
async function boxRemoveHandler(req, res) {
    const lineId = String((req.body || {}).lineId || "").trim();
    if (!lineId) return res.status(400).json({ error: "Missing lineId." });
    const removeDiscount = (req.body || {}).removeDiscount !== false;
    try {
        const contract = await getContractForCustomer(req.customerId);
        if (!contract) return res.status(403).json({ error: "No active subscription." });
        const url = `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts-remove-line-item?contractId=${contract.id}&lineId=${encodeURIComponent(lineId)}&removeDiscount=${removeDiscount}`;
        const headers = { "X-API-Key": APPSTLE_API_KEY, "Content-Type": "application/json" };

        // Remove hits the same contract-edit conflict as add, and it was a
        // REMOVE that finally produced the error above: two of them failed
        // back to back at 20:08:37 and 20:08:38 while clearing eight test
        // volumes. Removing in bulk is the same collision as adding in bulk.
        //
        // Safe to resend for the same reason: "the contract has changed" means
        // the edit was rejected, so the line is still there. Removing a line
        // that is already gone is harmless anyway — unlike a double ADD, this
        // direction cannot cost the customer money.
        const { response, attempts, ms } = await contractPut(url, headers, `proxy/box-remove line ${lineId}`);
        return res.status(200).json({ ok: true, attempts, ms, data: response.data });
    } catch (error) {
        const upstream = error.response?.data;
        console.error(
            "proxy/box-remove error:",
            error.response?.status || "",
            typeof upstream === "object" ? JSON.stringify(upstream) : (upstream || error.message)
        );
        // 409 not 502 — see the note on the add path. A 5xx here is replaced
        // by Shopify's themed error page and the reason never arrives.
        res.status(409).json({ ok: false, error: "Failed to remove item.", details: upstream || error.message });
    }
}

// POST box-skip — skip the customer's own upcoming order.
async function boxSkipHandler(req, res) {
    try {
        const contract = await getContractForCustomer(req.customerId);
        if (!contract) return res.status(403).json({ error: "No active subscription." });
        const url = `https://subscription-admin.appstle.com/api/external/v2/subscription-billing-attempts/skip-upcoming-order?subscriptionContractId=${contract.id}`;
        const response = await axios.put(url, {}, {
            headers: { "X-API-Key": APPSTLE_API_KEY, "Content-Type": "application/json" },
        });
        res.status(200).json({ ok: true, data: response.data });
    } catch (error) {
        return upstreamFailure(res, "box-skip", error, "Failed to skip order.");
    }
}

// POST box-discount { discountCode } — apply a code to the customer's own contract.
async function boxDiscountHandler(req, res) {
    const discountCode = String((req.body || {}).discountCode || "").trim();
    if (!discountCode) return res.status(400).json({ error: "Missing discountCode." });
    try {
        const contract = await getContractForCustomer(req.customerId);
        if (!contract) return res.status(403).json({ error: "No active subscription." });
        const url = `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts-apply-discount?contractId=${contract.id}&discountCode=${encodeURIComponent(discountCode)}`;
        const response = await axios.put(url, {}, {
            headers: { "X-API-Key": APPSTLE_API_KEY, "Content-Type": "application/json" },
        });
        res.status(200).json({ ok: true, data: response.data });
    } catch (error) {
        return upstreamFailure(res, "box-discount", error, "Failed to apply discount.");
    }
}

// The store's EXISTING App Proxy ("Appstle API Connector Honsama") maps
//   honsama.com/apps/appstle-proxy/*  →  {this app}/api/appstle/*
// and must not be reconfigured — the live ADD TO BOX button and cart drawer
// are built around this app. So the bookshelf's signed endpoints are exposed
// BOTH under /proxy/* (if the proxy URL ever points there) AND as aliases
// under /api/appstle/* where the existing proxy mapping already lands:
//   /apps/appstle-proxy/box      → /api/appstle/box       (signed read)
//   /apps/appstle-proxy/box-add  → /api/appstle/box-add   (signed add)
// "box-add" (not "add-line-item") avoids colliding with the legacy
// /api/appstle/add-line-item route the ADD TO BOX button uses today.
app.get("/proxy/box", boxHandler);
app.post("/proxy/add-line-item", addToBoxHandler);
app.get("/api/appstle/box", verifyAppProxy, requireAppstleKey, boxHandler);
app.post("/api/appstle/box-add", verifyAppProxy, requireAppstleKey, addToBoxHandler);
// /owned talks to the Admin API, not Appstle — signature only, no Appstle key.
app.get("/api/appstle/owned", verifyAppProxy, ownedHandler);
// Customer-declared ownership — Admin API only, same as /owned.
app.post("/proxy/owned-declare", ownedDeclareHandler);
app.post("/api/appstle/owned-declare", verifyAppProxy, ownedDeclareHandler);
// Follow-series toggles also talk to the Admin API only (customer metafield).
app.post("/proxy/follow", followToggleHandler(true));
app.post("/proxy/unfollow", followToggleHandler(false));
app.post("/api/appstle/follow", verifyAppProxy, followToggleHandler(true));
app.post("/api/appstle/unfollow", verifyAppProxy, followToggleHandler(false));
// Favorites (library pin-to-top) — same mechanics, honsama.favorites metafield.
app.post("/proxy/favorite", favoriteToggleHandler(true));
app.post("/proxy/unfavorite", favoriteToggleHandler(false));
app.post("/api/appstle/favorite", verifyAppProxy, favoriteToggleHandler(true));
app.post("/api/appstle/unfavorite", verifyAppProxy, favoriteToggleHandler(false));
// Drawer operations (signed): /apps/appstle-proxy/box-* → here.
app.get("/proxy/box-details", boxDetailsHandler);
app.post("/proxy/box-remove", boxRemoveHandler);
app.post("/proxy/box-skip", boxSkipHandler);
app.post("/proxy/box-discount", boxDiscountHandler);
app.get("/api/appstle/box-details", verifyAppProxy, requireAppstleKey, boxDetailsHandler);
app.post("/api/appstle/box-remove", verifyAppProxy, requireAppstleKey, boxRemoveHandler);
app.post("/api/appstle/box-skip", verifyAppProxy, requireAppstleKey, boxSkipHandler);
app.post("/api/appstle/box-discount", verifyAppProxy, requireAppstleKey, boxDiscountHandler);

// ✅ Error Handling for Undefined Routes
app.use((req, res) => {
    res.status(404).send("404: NOT_FOUND");
});

// ✅ Error middleware — CORS rejections (and any other middleware throw) get a
// clean 403/500 JSON instead of Express's default HTML stack trace page.
app.use((err, req, res, next) => {
    if (err && err.message === "Not allowed by CORS") {
        return res.status(403).json({ error: "Origin not allowed." });
    }
    console.error("Unhandled error:", err && err.message);
    res.status(500).json({ error: "Internal server error." });
});

// ✅ Expose the app as a Vercel Serverless Function
module.exports = app;
