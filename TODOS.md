# TODOS

Deferred work from reviews. Not urgent — revisit when the trigger condition hits.

## Set explicit `maxDuration` for today-sites.js, today-hourly.js, site-history.js

- **What:** Add `functions` entries to `vercel.json` for these 3 endpoints (they currently rely on Vercel's default timeout).
- **Why:** They fire 9-30 parallel calls to the Electric Era API. Fine at today's fleet size, but no configured ceiling means a slow EE API day or a larger fleet could hit an unconfigured default before finishing.
- **Pros:** One-line config per endpoint, zero behavior change, removes an unknowns.
- **Cons:** None — pure config addition.
- **Context:** Surfaced during the 2026-07-01 reliability review (`ceo-plans/2026-07-01-reliability-hardening.md`). `today.js`, `rebuild-baseline.js`, `log-accuracy.js` already have explicit `maxDuration` in `vercel.json`; these 3 newer endpoints (added after) never got the same treatment.
- **Effort:** S (human) → S (CC ~5 min)
- **Priority:** P3
- **Depends on:** Nothing. Independent of the accepted reliability items.

## Add a `/api/health` endpoint

- **What:** A lightweight endpoint that checks EE auth (token fetch succeeds) and Blob storage (a read succeeds) independent of loading the full dashboard.
- **Why:** No current monitoring consumer exists to call it, so it's not urgent — but if any future uptime check or status page gets added, this is the natural building block.
- **Pros:** Fast to verify "is everything actually working" without loading the full page. Small, isolated addition.
- **Cons:** Nothing calls it yet — value is latent until a monitoring consumer exists.
- **Context:** Surfaced during the 2026-07-01 reliability review. Deferred because there's no monitor to point at it today.
- **Effort:** S (human) → S (CC ~10 min)
- **Priority:** P3
- **Depends on:** Nothing.

## Add automated tests for the date-math helpers

- **What:** Unit tests for `utcOffsetString`, `localDateString`/`dateAtNDaysAgo`, and day-boundary logic — once consolidated into `api/_lib.js` by the 2026-07-01 reliability round.
- **Why:** This is the single most-regressed code in the repo's history — a DST/midnight-boundary bug shipped and got reverted once, and a separate "Black Friday timezone" fix was needed as a P1. Currently verified only by human eyeballing.
- **Pros:** Targets the highest-risk code with the least test-writing effort (a handful of pure functions, no mocking of EE API needed). Prevents the exact bug class that's already bitten this repo twice.
- **Cons:** Requires picking a test runner/framework (none exists in this repo yet) — small setup cost beyond the tests themselves.
- **Context:** Explicitly deferred by user choice during the 2026-07-01 review's cherry-pick ceremony, held for a future round after `api/_lib.js` exists (this round's item 1) — testing the pre-consolidation 6-file duplication would mean writing (and later deleting) the same tests 6 times.
- **Effort:** M (human) → S (CC ~20 min)
- **Priority:** P2
- **Depends on:** `api/_lib.js` existing (this round's item 1) — do this after, not before, that lands.

## Formalize a gitignored scratch-probe file

- **What:** A single `api/_probe.js` (gitignored, never committed) for ad-hoc Electric Era API investigation, replacing the current pattern of deploying a temporary debug endpoint to production and deleting it after use.
- **Why:** This exact deploy-investigate-delete cycle happened twice in one session (2026-07-01) and multiple times historically (`debug-revenue.js`, "debug: surface raw stats response shape", etc., visible in git log). Each cycle is a small window of temporary code live in production.
- **Pros:** Removes repeated deploy/cleanup overhead for future API investigations. Zero risk of a debug endpoint accidentally staying live.
- **Cons:** Requires pulling EE credentials locally to test outside of Vercel — currently EE_* env vars are Vercel-encrypted/sensitive and can't be pulled via `vercel env pull`, so this may need a different local-testing approach than a simple gitignored file (e.g., a local `.env` the user populates by hand, separate from Vercel's env store).
- **Context:** Surfaced during the 2026-07-01 reliability review. Workflow nicety, not a reliability fix — lowest severity of the items considered that round.
- **Effort:** S (human) → S (CC ~5 min, but contingent on resolving the local-credentials question above)
- **Priority:** P3
- **Depends on:** Nothing functionally, but the local-credentials constraint should be resolved first or the probe file won't be usable without redeploying anyway.
