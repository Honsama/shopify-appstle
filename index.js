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


// ✅ Error Handling for Undefined Routes
app.use((req, res) => {
    res.status(404).send("404: NOT_FOUND");
});

// ✅ Expose the app as a Vercel Serverless Function
module.exports = app;
