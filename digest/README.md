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
- `add-token.js` — HMAC signing of the one-tap add link (same secret,
  `digest-add:` prefix, month-bound) and the Undo token.
- `add-route.js` — the one-tap add route logic (`/api/digest/add`,
  `/api/digest/add-undo`), I/O injected; `../index.js` wires Appstle.
- `page.js` — the one-card page every public digest route answers with.
- `add-token.test.js`, `digest-add.test.js` — offline tests (`npm test`).
- `send-klaviyo.js` — **dormant.** The original Klaviyo event pusher, kept in
  case the Resend lane is ever retired. Its template tags no longer match.
- Not committed (gitignored): `digests.json`, `send-state.json`, `samples/`.

## Unsubscribe (we own compliance — there is no ESP doing it)
Every email carries `https://app.honsama.com/api/digest/unsubscribe?c=<customerId>&t=<hmac>` (`app.honsama.com` is a Cloudflare CNAME onto the Vercel project, added 2026-09-28; `shopify-appstle.vercel.app` still answers)
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
| `DIGEST_UNSUB_BASE` | send-resend.js | optional; default `https://app.honsama.com` |
| `DIGEST_SUBJECT` | send-resend.js | optional; default `Your shelf grew this month, {{first_name}} 📚` — only for digests with no new-release card |
| `DIGEST_ONE_TAP` | send-resend.js | `1` = cards carry the signed one-tap add link; anything else = product-page links (run 1). The rollback. |
| `DIGEST_NOW` | send-resend.js | dry runs only: pin the clock (e.g. `2026-11-16T17:00:00Z`) to see that day's subject tier. `--send` refuses while it is set. |

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
"New releases" = add-ons **published** in the last 16 days
(`DIGEST_WINDOW_DAYS`, keyed on `published_at`, not creation date). On the 16th
that catches this month's ~9th publish and not last month's; the drafts imported
that day count next month, once they go live.

Sanity-check the generate output: ~80–90 digests, one send day; new releases —
are these this month's published add-ons? If new releases is 0, this month's
add-ons aren't published yet — **wait**; the generator prints a warning and
every CTA in the email would be empty.

## One-tap add (2026-10-25; spec `resend_digest\ONE_TAP_ADD_SPEC.md`)
With `DIGEST_ONE_TAP=1`, each new-release card's **Add to my next box** and each
catch-up card's "add Vol. N" link go to
`https://app.honsama.com/api/digest/add?c=&v=&h=&m=&t=`:
- **GET never writes.** It shows a confirm page (cover, title, price, when it
  bills) with one **Add it** button. Scanners and previews can fetch it freely.
- **Add it** (a POST) re-checks everything and adds one line, quantity 1,
  through the same shared add function as Add to My Box → done page with
  **Undo** (removes exactly that line) and **Open My Box**.
- Already on the contract → "Already in your next box", no write. No ACTIVE
  contract → "Your box is paused". Bad, cut-short or other-month link →
  "This link isn't valid". After the 20th 11:59 PM PT the copy says "the box
  after"; the add is the same. Appstle failure → a "couldn't add" page.
- Every add is recorded in the customer metafield `honsama.digest_adds`
  (`{adds:[{variantId, month, at, lineId, undoneAt?}]}`); Undo stamps `undoneAt`.
- The route is always deployed; the flag only decides whether emails carry the
  links. Flag off = run 1's emails exactly (cards link to the product page).

Subject and preview follow the countdown to the 21st (0 · 1 · ≤3 · >3 days,
Pacific), ported from the volume alert; a red banner above the new-release
cards says the same. Digests with no new-release card keep `DIGEST_SUBJECT`.
`DIGEST_NOW=2026-11-16T17:00:00Z node digest/send-resend.js` previews a day.

## Day-75 continuation touch (2026-10-27; churn plan #16)
Same lane, its own three files: `day75-generate.js` → `day75.json` (active +
tagged + consenting subscribers at day 75–150 of their current run of box
orders, never touched before, with at least one started series whose next
unowned volume is live and in stock — up to 6 cards with live price and
compare-at), `day75-send.js` (dry run by default; `--send`, `--only`, `--to`,
`--limit`, `--forget <email>`), `day75-template.html`. Once in a lifetime:
`day75-state.json` is the permanent log (never reset) and every send tags the
customer `honsama_day75_YYYY_MM`. `DIGEST_ONE_TAP` governs its buttons too.
Run Mondays; the digest goes first on the 16th/17th (shared 100/day cap).
The rule, the SOP and the decisions: `HonsamaOps\Honsama Email Automation\day75_continuation\README.md`.
```
node digest/day75-generate.js            # who and why → digest/day75.json
node digest/day75-send.js                # dry run + digest/samples/day75-1..3.html
node digest/day75-send.js --send
```
`generate.js` exports its fetchers (and `fetchOwned` returns `boxOrderDates`)
and `send-resend.js` exports its renderer, clock and config for these scripts;
requiring either runs nothing.

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
