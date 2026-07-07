/*
 * Local dev runner — Vercel calls index.js as a serverless handler, so it only
 * exports the Express app. This wraps it in a real listener for local testing.
 * (Set APPSTLE_API_KEY / APP_API_TOKEN in .env or the environment to exercise
 * the real Appstle endpoints; without them the server runs but upstream calls fail.)
 */
// Minimal .env loader (no dotenv dependency) — lets local runs pick up
// APPSTLE_API_KEY / SHOPIFY_API_SECRET etc. without touching the environment.
const fs = require('fs');
const path = require('path');
try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n').forEach((line) => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
} catch (e) { /* no .env — fine */ }

const app = require('./index.js');
const port = process.env.PORT || 3001;
app.listen(port, () => console.log(`shopify-appstle dev server on http://localhost:${port}`));
