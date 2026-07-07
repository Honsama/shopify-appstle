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

function requireAppToken(req, res, next) {
    if (!process.env.APP_API_TOKEN) {
        return res.status(500).json({ error: "Server misconfigured: APP_API_TOKEN not set." });
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
    const redirectUri = `${APP_URL}/auth/callback`;

    console.log("DEBUG - Redirecting to:", redirectUri);

    const installUrl =
        `https://${shop}/admin/oauth/authorize?client_id=${SHOPIFY_API_KEY}` +
        `&scope=read_orders,write_orders,read_customers` +
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

        res.send("<h1>App installed successfully. You can now use the Appstle API Proxy.</h1>");
    } catch (error) {
        console.error("OAuth Error:", error.message);
        res.status(500).send("Failed to complete OAuth.");
    }
});

// ✅ Get api subscription customers contract Id
app.get("/api/appstle/:customerId", async (req, res) => {
    const { customerId } = req.params;

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
async function getContractForCustomer(customerId) {
    const response = await axios.get(
        `https://subscription-admin.appstle.com/api/external/v2/subscription-customers/${customerId}`,
        { headers: { "X-API-Key": APPSTLE_API_KEY, "Content-Type": "application/json" } }
    );
    const rows = Array.isArray(response.data) ? response.data : response.data ? [response.data] : [];
    const contracts = rows
        .map((r) => ({
            id: r.subscriptionContractId || r.contractId || r.id,
            status: String(r.status || "").toUpperCase(),
        }))
        .filter((c) => c.id);
    return contracts.find((c) => c.status === "ACTIVE") || contracts[0] || null;
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

// GET /proxy/box → { subscribed, contractId?, status?, skus[] }
// Hydrates the bookshelf's amber "in your next box" chips.
app.get("/proxy/box", async (req, res) => {
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
});

// POST /proxy/add-line-item  { variantId, quantity? } → adds a ONE-TIME item to
// the logged-in customer's own next box. isOneTimeProduct is hardcoded true.
app.post("/proxy/add-line-item", async (req, res) => {
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
});

// ✅ Error Handling for Undefined Routes
app.use((req, res) => {
    res.status(404).send("404: NOT_FOUND");
});

// ✅ Expose the app as a Vercel Serverless Function
module.exports = app;
