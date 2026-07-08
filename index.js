const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const cors = require("cors");

const app = express();
app.use(express.json());

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

// MIGRATION NOTE: the theme's subscription cart drawer still calls /api/appstle/*
// directly with no token. Enforcing the gate unconditionally would break it the
// moment this deploys. So: APP_API_TOKEN unset = legacy passthrough (today's
// behavior, no regression); APP_API_TOKEN set = enforced. Do NOT set the env var
// until the drawer has been ported to the signed /proxy routes.
function requireAppToken(req, res, next) {
    // /box and /box-add live under /api/appstle only because the store's App
    // Proxy ("Appstle API Connector Honsama") already targets this prefix —
    // they carry their own auth (Shopify's App Proxy signature), so the
    // bearer gate must never apply to them.
    // Signed App Proxy routes carry their own auth (Shopify HMAC signature +
    // logged_in_customer_id) — the bearer gate must never apply to them.
    var SIGNED_PATHS = ["/box", "/box-add", "/owned", "/box-details", "/box-remove", "/box-skip", "/box-discount"];
    if (SIGNED_PATHS.indexOf(req.path) !== -1) return next();
    if (!process.env.APP_API_TOKEN) {
        console.warn("APP_API_TOKEN not set - /api/appstle is running UNGATED (legacy mode).");
        return next();
    }
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    if (!token || !safeEqual(token, process.env.APP_API_TOKEN)) {
        return res.status(401).json({ error: "Unauthorized." });
    }
    next();
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
    if (!shop) {
        return res.status(400).send("Missing shop parameter.");
    }

    const state = crypto.randomBytes(16).toString("hex");
    // Shopify requires redirect_uri's host to match the app's configured URL
    // (shopify-appstle.vercel.app). If APP_URL is unset the old template made
    // "undefined/auth/callback" → invalid_request. Fall back to the request host.
    const base = APP_URL || `https://${req.get("host")}`;
    const redirectUri = `${base}/auth/callback`;

    console.log("DEBUG - Redirecting to:", redirectUri);

    // read_all_orders is a protected scope with NO checkbox in the dev
    // dashboard — but custom (non-public) apps may request it via OAuth
    // without review. It lifts the 60-day order window for /owned.
    const installUrl =
        `https://${shop}/admin/oauth/authorize?client_id=${SHOPIFY_API_KEY}` +
        `&scope=read_orders,read_all_orders,write_orders,read_customers` +
        `&state=${state}&redirect_uri=${redirectUri}`;

    console.log("DEBUG - Installation URL:", installUrl);
    res.redirect(installUrl);
});

// ✅ OAuth Callback (Secure Token Exchange)
app.get("/auth/callback", async (req, res) => {
    const { shop, code } = req.query;

    if (!shop || !code) {
        return res.status(400).send("Invalid parameters.");
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
        console.error("proxy/box error:", error.response?.data || error.message);
        res.status(502).json({ error: "Failed to read box." });
    }
}

// POST add  { variantId, quantity? } → adds a ONE-TIME item to the logged-in
// customer's own next box. isOneTimeProduct is hardcoded true.
async function addToBoxHandler(req, res) {
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
        const response = await axios.put(url, {}, {
            headers: { "X-API-Key": APPSTLE_API_KEY, "Content-Type": "application/json" },
        });

        res.status(200).json({ ok: true, contractId: contract.id, data: response.data });
    } catch (error) {
        console.error("proxy/add-line-item error:", error.response?.data || error.message);
        res.status(502).json({ error: "Failed to add to box.", details: error.response?.data || error.message });
    }
}

// GET owned → { available, skus[], orders } — the customer's FULL order history.
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
                                nodes { lineItems(first: 100) { nodes { sku } } }
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
                (o.lineItems?.nodes || []).forEach((li) => { if (li.sku) skus.push(li.sku); });
            });
            if (!orders.pageInfo.hasNextPage) break;
            after = orders.pageInfo.endCursor;
        }
        res.status(200).json({ available: true, orders: orderCount, skus: Array.from(new Set(skus)) });
    } catch (error) {
        console.error("proxy/owned error:", error.response?.data || error.message);
        res.status(502).json({ error: "Failed to read order history." });
    }
}

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
        console.error("proxy/box-details error:", error.response?.data || error.message);
        res.status(502).json({ error: "Failed to read box details." });
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
        const response = await axios.put(url, {}, {
            headers: { "X-API-Key": APPSTLE_API_KEY, "Content-Type": "application/json" },
        });
        res.status(200).json({ ok: true, data: response.data });
    } catch (error) {
        console.error("proxy/box-remove error:", error.response?.data || error.message);
        res.status(502).json({ error: "Failed to remove item.", details: error.response?.data || error.message });
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
        console.error("proxy/box-skip error:", error.response?.data || error.message);
        res.status(502).json({ error: "Failed to skip order.", details: error.response?.data || error.message });
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
        console.error("proxy/box-discount error:", error.response?.data || error.message);
        res.status(502).json({ error: "Failed to apply discount.", details: error.response?.data || error.message });
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

// ✅ Expose the app as a Vercel Serverless Function
module.exports = app;
