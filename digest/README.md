# Honsama Shelf Digest

Monthly personalized email to active Monthly Manga Box subscribers: new
volumes for the series they own/follow, top "catch up" series with progress
bars, and shelf stats (including how many volumes their boxes delivered).
Generated from Shopify data, sent **directly through Resend** from
`mail.honsama.com` at $0 (free tier). No ESP, no list — Shopify's own
marketing consent is the only source of truth.

The rule, the setup checklist, the monthly SOP and the 3-runs gate live in
`HonsamaOps/Honsama Email Automation/resend_digest/README.md`. This file is
the code-side reference.

## Files
- `generate.js` — builds `digests.json` (one entry per active subscriber).
  Active = billed a box in the last 45 days **and** Shopify email marketing
  consent = `SUBSCRIBED` (everyone else is counted and skipped). Uses the
  collection engine + series-index from the honsama-app repo, box_month
  metaobjects, and the honsama.following / honsama.favorites metafields.
- `send-resend.js` — renders `email-template.html` per customer and sends
  through the Resend API. **Dry run by default**; `--send` to send.
  `--limit N` (default 100 = Resend's free daily cap), `--only a@b.com`
  (self-send / canary), `--reset-state`. Resumable: `send-state.json`
  remembers what went out for the current `digests.json`.
- `email-template.html` — the email. Django-style tags rendered locally by
  the sender (variables with a default filter, if/endif, for/endfor).
- `unsub-token.js` — HMAC signing of the unsubscribe link, shared with the
  box app's `/api/digest/unsubscribe` route in `../index.js`.
- `send-klaviyo.js` — **dormant.** The original Klaviyo event pusher, kept in
  case the Resend lane is ever retired. Its template tags no longer match.
- Not committed (gitignored): `digests.json`, `send-state.json`, `samples/`.

## Unsubscribe (we own compliance — there is no ESP doing it)
Every email carries `https://shopify-appstle.vercel.app/api/digest/unsubscribe?c=<customerId>&t=<hmac>`
in the footer and in `List-Unsubscribe` / `List-Unsubscribe-Post` headers.
- Plain click → one-line page with one **Unsubscribe** button (a plain link
  with `&confirm=1`). The extra click stops mail-scanner prefetches from
  unsubscribing people by accident.
- Button, or a mail client's one-click POST → `customerEmailMarketingConsentUpdate`
  → `UNSUBSCRIBED` in Shopify. The page says the box itself is untouched.
- The token is `HMAC-SHA256(DIGEST_UNSUB_SECRET, "digest-unsubscribe:<id>")`,
  no expiry. The secret must be identical in `.env` (sender) and on the
  Vercel project `shopify-appstle-new` (verifier). Missing on Vercel → the
  page says "not set up yet, email support" (503) rather than failing open.
- Never point the link at a Shopify Email unsubscribe — those only manage
  Shopify Email; ours writes consent directly.

## .env keys (repo root, never committed)
| Key | Used by | Notes |
|---|---|---|
| `ADMIN_API_TOKEN` | generate.js, index.js | `shpat_` of the store custom app; needs `read_orders`, `read_all_orders`, `read_customers`, **`write_customers`** (the consent flip) |
| `RESEND_API_KEY` | send-resend.js | Resend → API Keys → *Sending access* only |
| `DIGEST_UNSUB_SECRET` | send-resend.js, index.js (Vercel) | random string, e.g. `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `DIGEST_POSTAL_ADDRESS` | send-resend.js | physical mailing address printed in the footer (CAN-SPAM) |
| `DIGEST_FROM` | send-resend.js | optional; default `Ricky at Honsama <ricky@mail.honsama.com>` — must stay on the subdomain |
| `DIGEST_REPLY_TO` | send-resend.js | optional; default `support@honsama.com` |
| `DIGEST_UNSUB_BASE` | send-resend.js | optional; default `https://shopify-appstle.vercel.app` |
| `DIGEST_SUBJECT` | send-resend.js | optional; default `Your shelf grew this month, {{first_name}} 📚` |

The sender refuses `--send` until the key, the secret, the postal address, a
subdomain From, and a `customer_id` on every digest all read `OK` in its
preflight.

## Monthly run (~the 16th — after the add-ons run, before the 21st cutoff)
```
cd shopify-appstle
node digest/generate.js            # builds digest/digests.json, prints counts
node digest/send-resend.js         # dry run — read the summary, open digest/samples/
node digest/send-resend.js --send  # sends up to 100; re-run on the 17th for the rest
```
Sanity-check the generate output: subscribers ~100–113, new releases ~30–50.
If new releases is 0, the add-ons run hasn't happened yet — **wait**; the
generator prints a warning and every CTA in the email would be empty.

## Self-send and canary
```
node digest/send-resend.js --only ricky.do@honsama.com             # dry run, sample-1.html = your email
node digest/send-resend.js --only ricky.do@honsama.com --send      # one real email
node digest/send-resend.js --only a@x.com,b@y.com,c@z.com --send   # canary (5 friendly subscribers)
node digest/send-resend.js --reset-state                            # if you need to re-send to the same people
```
`--only` needs the address to be in `digests.json` (i.e. an active,
consenting subscriber with a non-empty shelf).

## Notes
- Customers with an empty shelf (no parseable volumes) are skipped.
- A "new release" only appears for a customer when its series is on their
  shelf or followed AND they don't own that volume yet — box-delivered
  volumes are excluded automatically.
- Timing intent: every "Add to my box" CTA is actionable because the email
  lands before the 21st cutoff.
- Resend free tier: 3,000/month, **100/day**, 2 requests/second (the sender
  spaces sends at 600 ms and stops cleanly on a daily-quota 429).
- Engine/index paths default to `../honsama-app/theme/assets/`; override
  with `ENGINE_PATH` / `SERIES_INDEX_PATH` env vars if the layout changes.
