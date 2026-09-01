# Honsama Automation Agents — Roadmap & Reference

> The master reference for automating Honsama (Monthly Manga Box + add-on
> catalog at honsama.com). It maps every agent — existing and planned — to a
> role, its responsibilities, its cadence, and a kickoff prompt you can paste
> into a Claude session to build or run it.
>
> **How to use this doc:** when you're ready to build the next agent, open the
> tier list, pick the highest unbuilt item, and paste its kickoff prompt into a
> new Claude Code session. Each agent should ship as a skill (like the existing
> ones), and recurring agents get a scheduled Routine on the cadence listed.

---

## The monthly operating loop

Everything below hangs off this calendar. "Box month" = billing month + 1,
with the day-22 boundary (a subscriber billed on/after the 22nd is in the
following box month).

| When | What happens | Agent(s) responsible |
|---|---|---|
| Early month | Scrape publisher calendars, build next month's listings | Catalog Intake (existing skills) |
| After import | Verify listings landed correctly, sync Masterlist | **Listing QA & Masterlist Sync** (planned) |
| ~13th–15th | Pick next month's box titles | **Box Curation** (planned) |
| ~16th | Shelf Digest email to subscribers | **Email Lifecycle** (planned — pipeline built, needs ESP) |
| 16th–21st | Reveal content + videos, add-on window open | Content Production (existing skills) |
| 21st/22nd | Add-on cutoff, box month closes | **Inventory & Reorder** check before this (planned) |
| Daily | Orders, billing failures, cancellations, skips | **Subscription Ops** (planned) |
| Weekly | KPI rollup, release-date drift check, health check | **KPI**, **Release-Date Drift**, **Proxy Health** (planned) |

---

## What already exists (so nothing overlaps)

| Agent / skill | Role | Covers | Does NOT cover |
|---|---|---|---|
| `follow-up-add-ons-shopify` | Catalog intake — sequels | Monthly CSV of Vol 2+ releases for series already in the store; scrapes Viz/Kodansha/Yen Press/Seven Seas; uploads covers | Vol 1 debuts; verifying the import; updating the Masterlist |
| `new-volume-1-shopify` | Catalog intake — debuts | Monthly CSV of every Vol 1 debut, provisional SKUs | Masterlist filtering (by design); SKU reconciliation afterward |
| `honsama-box-reveal` | Reveal copywriter | Synopses, "Why We Picked It", fun facts, per-platform captions for the monthly box | Picking the titles; posting the content |
| `manga-script-writer` | Video scriptwriter | Hype short-form scripts (hooks + CTAs) per title | Audio, panels, rendering |
| `vo-edit` | Audio editor | Raw VO → 3 clean WAVs + SRTs | Recording; video assembly |
| `mangapanelscan` | Panel prep (manual path) | Numbered panel set + EDIT_GUIDE for CapCut assembly | Rendering |
| `mangavideomaker` | Video renderer (auto path) | Chapters + VO package → 3 finished MP4s with captions and endcard | Posting/scheduling |
| `morning` | Daily brief | Morning brief artifact | Business KPIs (until KPI agent feeds it) |
| `shopify-appstle` app (this repo) | Subscriber box UI backend | Box view/add/remove/skip/discount via Appstle; follow/favorite/owned metafield routes | Monitoring itself (Proxy Health agent's job) |
| `digest/` pipeline (this repo) | Shelf Digest generator | Personalized monthly email JSON + Klaviyo push script + template — **built, shelved: no ESP** | Actually sending — blocked until Email Lifecycle agent stands up an ESP |

**Gap summary:** intake, content, and the subscriber UI are automated. Nothing
yet closes the loop from your own data back into decisions (curation), nothing
watches operations (billing, churn, inventory, health), and finished content
still gets posted by hand.

---

## Priority hierarchy

Build top to bottom. Tier 1 items mostly unlock work that's already done or
data you already collect; Tier 2 is daily/monthly ops currently done by hand;
Tier 3 is polish.

### Tier 1 — build first (unlocks sunk work + unique data)

1. **Email Lifecycle Agent** — the digest pipeline is finished and tested;
   it's blocked only on an ESP account. Highest ROI per hour of work.
2. **Listing QA & Masterlist Sync Agent** — protects the catalog machine that
   runs every single month; errors here compound (a missed Masterlist entry
   means missed sequels forever after).
3. **Box Curation Agent** — turns `honsama.following`, `honsama.favorites`,
   and owned-shelf data into evidence-based box picks. This improves the
   product itself.

### Tier 2 — operations (build once Tier 1 is running)

4. **Subscription Ops & Churn Agent** — daily; failed billings and skips are
   revenue leaking right now.
5. **Inventory & Reorder Agent** — monthly, before the 21st cutoff.
6. **KPI Agent** — weekly; feeds `/morning` so trends surface passively.

### Tier 3 — polish (build when Tier 2 is stable)

7. **Social Publishing Agent** — closes the last mile on content.
8. **Release-Date Drift Monitor** — weekly re-scrape for slipped dates.
9. **Support Inbox Triage Agent** — needs an inbox connector first.
10. **Proxy Health Monitor** — cheap to build, quietly protects the core UX.

---

## Agent specs — roles, responsibilities, kickoff prompts

### 1. Email Lifecycle Agent 🥇

- **Role:** Email marketing operator. Owns everything that lands in a
  subscriber's inbox.
- **Responsibilities:**
  - One-time: stand up the ESP (Klaviyo free tier per `digest/README.md`, or
    evaluate a direct-send alternative), create the Shelf Digest flow, run the
    self-test send.
  - Monthly (~16th, after the add-ons run, before the 21st): run
    `digest/generate.js`, sanity-check counts (subscribers ~100, new releases
    ~30–50; 0 releases = add-ons run hasn't happened, wait), dry-run
    `send-klaviyo.js`, then `--send`.
  - Later: abandoned-cart, post-purchase, and box-reveal announcement flows.
- **Not responsible for:** writing reveal content (Reveal skill), picking
  digest contents (the pipeline computes them).
- **Cadence:** monthly send; flows run themselves once live.
- **Needs:** `ADMIN_API_TOKEN`, `KLAVIYO_PRIVATE_KEY` in `.env`
  (setup steps in `digest/README.md`), `honsama-app` repo for the
  engine/series-index files.
- **Kickoff prompt:**
  > Read `digest/README.md` and `honsama-app/DIGEST-EMAIL-BRIEF.md`, then help
  > me unshelve the Shelf Digest. Walk me through the Klaviyo signup and key
  > setup, paste-ready flow config, and run a dry-run of the full monthly
  > pipeline. Once my test send looks right, set up a monthly Routine that
  > runs generate → dry-run → send on the 16th and reports the counts to me
  > before sending.

### 2. Listing QA & Masterlist Sync Agent 🥇

- **Role:** Catalog auditor. The CSV skills end at "CSV produced" — this agent
  owns everything after import.
- **Responsibilities:**
  - After each monthly import: verify every row landed in Shopify (product
    exists, image loaded, price/compare-at right, tags + collections set,
    correct publish status); report and fix discrepancies.
  - Append new Vol 1 series from the debut run to the Manga Masterlist so
    next month's follow-up run catches their Vol 2s.
  - Reconcile provisional SKUs from `new-volume-1-shopify` to real ISBNs once
    available; dedupe SKUs across the catalog.
  - Flag orphans: store products missing from the Masterlist and vice versa.
- **Not responsible for:** building the CSVs (intake skills), pricing strategy.
- **Cadence:** after each monthly import (both CSV runs).
- **Needs:** Shopify MCP (products/collections), Manga Masterlist read+write,
  the month's import CSVs.
- **Kickoff prompt:**
  > Build a listing-QA skill for Honsama. Input: the month's import CSV(s).
  > It checks every row against the live Shopify store (existence, image,
  > price, tags, collections, status), outputs a pass/fail report with fixes
  > applied or proposed, appends any new Vol 1 series to the Manga Masterlist,
  > and lists provisional SKUs still needing real ISBNs. Start by reading the
  > follow-up-add-ons and new-volume-1 skills so the formats match.

### 3. Box Curation Agent 🥇

- **Role:** Merchandiser. Proposes each month's 2–4 box titles and add-on
  stocking depth from actual subscriber data.
- **Responsibilities:**
  - Aggregate `honsama.following` and `honsama.favorites` across all
    customers; rank series by active-subscriber demand.
  - Cross-reference owned shelves to exclude titles a large share of
    subscribers already own (a box pick most people own is a refund risk).
  - Cross-reference the month's release calendar (new volume of a
    heavily-followed series = strong pick).
  - Output a ranked shortlist with the evidence per title: follows, favorites,
    % ownership overlap, release timing, genre balance vs. recent boxes.
  - Recommend stocking depth for the top add-ons from the same signals.
- **Not responsible for:** the final call (that's yours), writing reveal
  content, ordering stock.
- **Cadence:** monthly, ~13th–15th (before reveal content is made).
- **Needs:** Shopify MCP (customers + metafields via GraphQL), the `/owned`
  logic in this repo as reference, the month's release CSV, past box lineups.
- **Kickoff prompt:**
  > Build a box-curation skill for Honsama. Pull honsama.following and
  > honsama.favorites metafields across all customers billed in the last 45
  > days, plus their owned shelves (reuse the logic behind the /owned endpoint
  > in shopify-appstle). Rank candidate box titles for [MONTH] combining
  > demand signals, ownership overlap (lower is better), and the release
  > calendar. Output a ranked shortlist of 6–8 with evidence per title so I
  > can pick the final 2–4.

### 4. Subscription Ops & Churn Agent 🥈

- **Role:** Revenue guardian. The daily eyes on orders and subscriptions.
- **Responsibilities:**
  - Daily scan: failed/pending Appstle billings (dunning), new cancellations,
    new skips, orders unfulfilled beyond N days, address problems.
  - Draft (not send, until trusted) win-back messages for cancellations and a
    nudge for payment failures before the box month closes.
  - Track skip streaks — two consecutive skips = churn risk, surface it.
  - Weekly digest of churn reasons and saves.
- **Not responsible for:** support replies (Inbox Triage), KPI math (KPI
  agent), the email templates themselves once Email Lifecycle owns flows.
- **Cadence:** daily Routine; weekly summary.
- **Needs:** Shopify MCP (orders/customers), Appstle API (key already used by
  this repo), later an outbound channel via the ESP.
- **Kickoff prompt:**
  > Build a daily subscription-ops skill for Honsama. Using the Shopify MCP
  > and the Appstle API (see how shopify-appstle/index.js authenticates),
  > scan for failed billings, new cancellations, skips, and unfulfilled
  > orders > 5 days. Output a short daily report with a drafted win-back or
  > dunning message per case, and track skip streaks per customer. Set it up
  > as a daily morning Routine.

### 5. Inventory & Reorder Agent 🥈

- **Role:** Stock controller for the box and top add-ons.
- **Responsibilities:**
  - Before the 21st: check inventory on the box titles and top-selling
    add-ons vs. active subscriber count + preorder volume; flag anything that
    will oversell.
  - Draft the distributor reorder list (title, ISBN, qty, distributor).
  - Consume the Curation agent's demand estimates for stocking depth.
  - Flag dead stock (add-ons with no sales in N months) for discounting.
- **Not responsible for:** placing orders (drafts only), pricing.
- **Cadence:** monthly, ~18th–20th; optional weekly low-stock ping.
- **Needs:** Shopify MCP (`get-inventory-levels`, orders), subscriber count,
  distributor list.
- **Kickoff prompt:**
  > Build an inventory skill for Honsama. Before the 21st cutoff, compare
  > inventory levels for this month's box titles and the top 20 add-ons
  > against active subscriber count and open preorders. Flag oversell risk,
  > draft a reorder list grouped by distributor, and list dead stock (no
  > sales in 90 days) as discount candidates.

### 6. KPI Agent 🥈

- **Role:** Analyst. One source of truth for how the business is trending.
- **Responsibilities:**
  - Weekly ShopifyQL rollup: subscriber count, MRR, churn %, add-on attach
    rate, AOV, top sellers, revenue vs. prior 4 weeks.
  - Once email is live: digest open/click and CTA-attributed add-on sales.
  - Feed the highlights into the `/morning` brief; flag anomalies (churn
    spike, attach-rate drop) rather than just reporting numbers.
- **Not responsible for:** acting on the numbers (Ops/Curation agents).
- **Cadence:** weekly Routine (Monday), monthly deep-dive.
- **Needs:** Shopify MCP (`run-analytics-query`), Appstle subscription counts.
- **Kickoff prompt:**
  > Build a weekly KPI skill for Honsama using ShopifyQL: subscribers, MRR,
  > churn, add-on attach rate, AOV, top 10 sellers, each vs. the prior
  > 4-week average, with anomalies called out first. Then wire the headline
  > numbers into my /morning brief and schedule it as a Monday Routine.

### 7. Social Publishing Agent 🥉

- **Role:** Distribution. Gets finished content actually posted, on schedule.
- **Responsibilities:**
  - Maintain the posting calendar (reveal posts 16th–21st window, video drops,
    evergreen reposts).
  - Schedule/post reveal captions and rendered MP4s via Buffer/Later/Meta API
    (pick one during build).
  - Report basic engagement per post back to the KPI agent.
- **Not responsible for:** making content (existing skills), community replies.
- **Cadence:** after each reveal/video package; weekly calendar check.
- **Blocked by:** choosing + connecting a scheduling tool.
- **Kickoff prompt:**
  > Help me pick a posting API for Honsama (Buffer vs. Later vs. Meta/TikTok
  > native) given I post to Instagram, Facebook, TikTok, and X. Then build a
  > skill that takes a box-reveal package (captions + MP4s) and schedules the
  > posts across the 16th–21st window, with a dry-run mode that shows me the
  > calendar before anything goes live.

### 8. Release-Date Drift Monitor 🥉

- **Role:** Calendar watchdog. Publishers slip dates constantly.
- **Responsibilities:**
  - Weekly re-scrape of the four publisher calendars for titles already
    listed as preorders; diff against stored listing dates.
  - Update Shopify product metadata on slips; output a note for affected
    preorder customers (hand to Email Lifecycle to send).
- **Not responsible for:** initial listing creation (intake skills).
- **Cadence:** weekly Routine.
- **Kickoff prompt:**
  > Build a release-date drift skill: re-scrape the Viz, Kodansha, Yen Press,
  > and Seven Seas calendars (reuse the scraping approach from the
  > follow-up-add-ons skill), diff release dates against live Honsama preorder
  > listings, update slipped dates in Shopify, and output a customer-facing
  > note per slipped title.

### 9. Support Inbox Triage Agent 🥉

- **Role:** First-line support. Drafts, never sends unsupervised.
- **Responsibilities:**
  - Triage incoming mail: skip requests, address changes, damaged books,
    "where's my box", cancellations.
  - Draft replies from a canned-answer library; execute the safe actions
    (skip a month via Appstle, address update) with your approval.
  - Escalate anything unusual untouched.
- **Blocked by:** connecting the support inbox (Gmail connector or similar).
- **Cadence:** daily, or event-driven once connected.
- **Kickoff prompt:**
  > My support inbox is connected — build a triage skill for Honsama support
  > mail. Classify each message (skip / address / damaged / shipping status /
  > cancel / other), draft a reply in my voice for each, list the Appstle or
  > Shopify action needed, and never send or execute without my sign-off.
  > Start by drafting the canned-answer library with me.

### 10. Proxy Health Monitor 🥉

- **Role:** SRE for this repo's Vercel app — the subscriber box UI depends
  on it.
- **Responsibilities:**
  - Scheduled synthetic checks against the app-proxy endpoints (`/proxy/box`,
    `/proxy/box-details`, `/proxy/owned`, follow/favorite) with a test
    customer; alert on errors, timeouts, or oversized responses (the /owned
    5xx → 675KB-page class of failure).
  - Watch Vercel deploy status; sanity-check after each deploy.
- **Not responsible for:** feature work on the app.
- **Cadence:** hourly or daily Routine (start daily, tighten if it catches
  things).
- **Kickoff prompt:**
  > Build a health-check skill for the shopify-appstle Vercel app: hit each
  > app-proxy endpoint with signed test requests (see verifyAppProxy in
  > index.js for the HMAC), assert status + response size + latency bounds,
  > and alert me only on failures. Schedule it as a daily Routine.

---

## Roles & responsibilities at a glance

| # | Agent | Role in one line | Tier | Cadence |
|---|---|---|---|---|
| 1 | Email Lifecycle | Owns the inbox: digest + flows | 1 | Monthly (16th) |
| 2 | Listing QA & Masterlist Sync | Audits imports, keeps Masterlist true | 1 | After each import |
| 3 | Box Curation | Data-driven box picks & stocking depth | 1 | Monthly (~14th) |
| 4 | Subscription Ops & Churn | Catches leaking revenue daily | 2 | Daily |
| 5 | Inventory & Reorder | No oversells at cutoff; reorder drafts | 2 | Monthly (~19th) |
| 6 | KPI | One trending source of truth → /morning | 2 | Weekly (Mon) |
| 7 | Social Publishing | Content actually gets posted | 3 | Per package |
| 8 | Release-Date Drift | Preorder dates stay honest | 3 | Weekly |
| 9 | Support Inbox Triage | Drafted replies, safe actions, escalation | 3 | Daily |
| 10 | Proxy Health | The box UI stays up | 3 | Daily |

**Dependency notes:** 3 → feeds 5 (demand → stocking) and the reveal skill
(picks → content). 1 unblocks the customer-facing halves of 4 and 8. 6 gets
richer after 1 (email metrics). 9 waits on an inbox connector; 7 waits on a
scheduling tool choice.

---

*Last updated: 2026-09-01. When an agent ships, note its skill name next to
its entry so this doc stays the map of what covers what.*
