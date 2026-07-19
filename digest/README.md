# Honsama Shelf Digest

> **⚠️ SHELVED 2026-07-19 — no ESP yet.** Ricky doesn't have Klaviyo, so this
> pipeline is built + tested but not launched. Full context, revival options
> (Klaviyo / other ESP / direct send), and the rendered sample are in
> `honsama-app/DIGEST-EMAIL-BRIEF.md`. Everything below is written for the
> Klaviyo path and applies as-is once an account exists.

Monthly personalized email to active Monthly Manga Box subscribers:
new volumes for the series they own/follow, top "catch up" series with
progress bars, and shelf stats (including how many volumes their boxes
delivered). Sent via Klaviyo; generated from Shopify data.

## Files
- `generate.js` — builds `digests.json` (one entry per active subscriber).
  Active = billed a box in the last 45 days. Uses the collection engine +
  series-index from the honsama-app repo, box_month metaobjects, and the
  honsama.following / honsama.favorites customer metafields.
- `send-klaviyo.js` — pushes one "Shelf Digest" event per customer to
  Klaviyo. **Dry run by default**; `--send` to actually push.
- `email-template.html` — the flow email (paste once into Klaviyo).

## One-time setup (Ricky)
1. **ADMIN_API_TOKEN** into `shopify-appstle/.env` — same `shpat_` token as
   the Vercel env var (Vercel → project → Settings → Environment Variables).
2. **Klaviyo private key**: Klaviyo → Settings → API keys → Create Private
   API Key (Events: Full, Profiles: Full) → add to `.env` as
   `KLAVIYO_PRIVATE_KEY=pk_...`
3. **Create the flow**: Klaviyo → Flows → Create Flow → Build from scratch →
   Trigger: **Metric** → "Shelf Digest" (appears after the first dry-real
   event; send one test event first if the metric isn't listed yet).
   Add an **Email** action → use the HTML editor → paste
   `email-template.html` → subject:
   `Your shelf grew this month, {{ person.first_name|default:'reader' }} 📚`
   → set the flow **Live**.
4. Send yourself a test: temporarily edit `digests.json` down to just your
   own email's entry and run `node digest/send-klaviyo.js --send`.

## Monthly run (~the 16th — after the add-ons run, before the 21st cutoff)
```
cd shopify-appstle
node digest/generate.js          # builds digest/digests.json, prints counts
node digest/send-klaviyo.js      # dry run — eyeball the summary lines
node digest/send-klaviyo.js --send
```
Sanity-check the generate output: subscribers ~100, new releases ~30-50.
If new releases is 0, the add-ons run hasn't happened yet — wait for it.

## Notes
- Customers with an empty shelf (no parseable volumes) are skipped.
- A "new release" only appears for a customer when its series is on their
  shelf or followed AND they don't own that volume yet — box-delivered
  volumes are excluded automatically.
- Timing intent: every "Add to my box" CTA is actionable because the email
  lands before the 21st cutoff.
- Free Klaviyo tier caps ~500 sends/mo — fine at current subscriber count.
- Engine/index paths default to `../honsama-app/theme/assets/`; override
  with ENGINE_PATH / SERIES_INDEX_PATH env vars if the layout changes.
