// api/_monta.js — all Monta Partner API logic lives here.
//
// Underscore-prefixed so Vercel excludes it from function routing (it is imported,
// never served). See https://github.com/vercel/vercel/discussions/4983
//
// Monta differs from Electric Era in two ways that shape this module:
//
//  1. There is NO aggregate revenue endpoint. `/charge-point-statistics/by-site`
//     returns totalEnergyConsumed plus uptime, but no revenue at all. So revenue
//     has to be summed from individual `/charges` transactions.
//
//  2. `price` is in DOLLARS (currency.decimals: 2) and `consumedKwh` in kWh —
//     neither needs a divisor, unlike EE's totalRevenue which is in cents.
//
// The upside of (1) is that one windowed fetch yields both the daily total AND the
// hourly breakdown, so Monta needs far fewer calls than EE: a 35-day baseline is
// ~45 Monta calls versus EE's 840.

const AUTH_URL = "https://partner-api.monta.com/api/v1/auth/token";
const API_BASE = "https://partner-api.monta.com/api/v1";
const PER_PAGE = 100;         // API caps perPage at 100; larger requests still return 100
const MAX_PAGES = 400;        // runaway guard, ~40k charges
const CA_ZIP_MIN = 90000;     // California ZIP range
const CA_ZIP_MAX = 96199;

export const MONTA_PREFIX = "monta";

export function montaConfigured() {
  return !!(process.env.MONTA_CLIENT_ID && process.env.MONTA_CLIENT_SECRET);
}

export async function montaToken() {
  const r = await fetch(AUTH_URL, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      clientId: process.env.MONTA_CLIENT_ID,
      clientSecret: process.env.MONTA_CLIENT_SECRET,
    }),
  });
  if (!r.ok) {
    const e = new Error("monta auth " + r.status);
    e.code = (r.status === 401 || r.status === 403) ? "MONTA_AUTH_INVALID" : "MONTA_AUTH_ERROR";
    throw e;
  }
  // The 1h access token outlives any single serverless invocation, so the refresh
  // flow isn't needed here — we just re-auth per invocation like the EE path does.
  return (await r.json()).accessToken;
}

async function get(token, path, params) {
  const qs = new URLSearchParams(params).toString();
  const url = `${API_BASE}${path}${qs ? "?" + qs : ""}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(url, {
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
    });
    if (r.ok) return r.json();
    if (attempt === 0) await new Promise(res => setTimeout(res, 300));
    else {
      const e = new Error(`monta GET ${path} -> ${r.status}`);
      e.code = (r.status === 401 || r.status === 403) ? "MONTA_AUTH_INVALID" : "MONTA_ERROR";
      throw e;
    }
  }
}

// California sites only. Monta leaves `province` null on every site, so ZIP range
// is the only reliable state signal. A future CA site is picked up automatically;
// a NY site (zip 10001) is excluded.
export function isCaliforniaSite(site) {
  const a = site?.location?.address;
  if (!a) return false;
  if (a.country && a.country !== "United States") return false;
  const zip = parseInt(String(a.zip || "").slice(0, 5), 10);
  return Number.isFinite(zip) && zip >= CA_ZIP_MIN && zip <= CA_ZIP_MAX;
}

export async function montaCASites(token) {
  const data = await get(token, "/sites", { perPage: PER_PAGE });
  return (data?.data || [])
    .filter(s => !s.deletedAt)
    .filter(isCaliforniaSite)
    .map(s => ({ id: s.id, name: s.name, zip: s.location?.address?.zip, city: s.location?.address?.city }));
}

// Pagination is parallelised after the first page reveals totalPageCount. A large
// site like Pepsi spans ~36 pages over 30 days; fetching those serially took over
// 60s and tripped the function timeout. Batched fives cut it to ~8 rounds.
async function chargesForSite(token, siteId, fromISO, toISO) {
  const params = { siteId, fromDate: fromISO, toDate: toISO, perPage: PER_PAGE };
  const first = await get(token, "/charges", { ...params, page: 0 });
  const out = [...(first?.data || [])];
  const total = Math.min(first?.meta?.totalPageCount ?? 1, MAX_PAGES);
  if (total <= 1 || out.length === 0) return out;

  const pages = Array.from({ length: total - 1 }, (_, i) => i + 1);
  const BATCH = 5;
  for (let i = 0; i < pages.length; i += BATCH) {
    const batch = pages.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(page => get(token, "/charges", { ...params, page }).catch(() => null))
    );
    for (const d of results) if (d?.data) out.push(...d.data);
  }
  return out;
}

// Local hour index (0-23) for a UTC instant, in the dashboard's timezone.
function localHour(tz, iso) {
  const h = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour: "numeric", hour12: false,
  }).format(new Date(iso));
  return parseInt(h, 10) % 24;
}

// Local YYYY-MM-DD for a UTC instant, in the dashboard's timezone.
function localDate(tz, iso) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(iso));
}

// Distributes one charge session across (date, hour) buckets.
//
// Energy comes straight from `kwhPerHour[]`, whose entries carry their own UTC
// timestamps — so bucketing is exact and does NOT depend on which timestamp
// Monta's date filter happens to use, and a session spanning midnight splits
// correctly across both days.
//
// Revenue has only a session-level `price`, so it's allocated across the same
// hours in proportion to energy delivered. Revenue here is energy-priced, so
// that matches how EE's per-hour windows report it and keeps the cumulative
// curve smooth instead of lumpy. Falls back to attributing the whole price to
// the start hour when kwhPerHour is missing or empty.
function spreadCharge(charge, tz, add) {
  const price = Number(charge.price) || 0;
  const perHour = Array.isArray(charge.kwhPerHour) ? charge.kwhPerHour : [];
  const totalKwh = perHour.reduce((s, p) => s + (Number(p.value) || 0), 0);

  if (perHour.length && totalKwh > 0) {
    for (const p of perHour) {
      const kwh = Number(p.value) || 0;
      if (!kwh) continue;
      add(localDate(tz, p.time), localHour(tz, p.time), price * (kwh / totalKwh), kwh);
    }
    return;
  }
  // No hourly telemetry — attribute everything to the session start.
  const anchor = charge.startedAt || charge.completedAt || charge.createdAt;
  if (!anchor) return;
  add(localDate(tz, anchor), localHour(tz, anchor), price, Number(charge.consumedKwh) || 0);
}

/**
 * Fetch and bucket Monta charges.
 *
 * Fetches a window padded by 1 day on each side so sessions straddling a boundary
 * are captured regardless of which timestamp Monta filters on; attribution is then
 * done locally and only the requested dates are returned.
 *
 * @returns {{
 *   sites: Array<{id,name}>,
 *   byDate:  Record<string, {revenue:number, energyKwh:number}>,
 *   byDateHour: Record<string, Array<{revenue:number, energyKwh:number}>>,  // 24 per date
 *   perSiteByDate: Record<string, Record<string, {revenue:number, energyKwh:number}>>
 * }}
 */
export async function montaBuckets(token, { fromDate, toDate, tz, siteIds }) {
  const sites = siteIds
    ? siteIds.map(id => ({ id, name: String(id) }))
    : await montaCASites(token);

  const pad = d => {
    const x = new Date(d + "T12:00:00Z");
    return x;
  };
  const fromISO = new Date(pad(fromDate).getTime() - 36 * 3600e3).toISOString();
  const toISO = new Date(pad(toDate).getTime() + 36 * 3600e3).toISOString();

  const byDate = {};
  const byDateHour = {};
  const perSiteByDate = {};

  const blank = () => ({ revenue: 0, energyKwh: 0 });
  const ensureDate = d => {
    if (!byDate[d]) byDate[d] = blank();
    if (!byDateHour[d]) byDateHour[d] = Array.from({ length: 24 }, blank);
    return d;
  };

  for (const site of sites) {
    const charges = await chargesForSite(token, site.id, fromISO, toISO);
    const key = `${MONTA_PREFIX}:${site.id}`;
    perSiteByDate[key] = {};
    for (const c of charges) {
      spreadCharge(c, tz, (date, hour, revenue, energyKwh) => {
        ensureDate(date);
        byDate[date].revenue += revenue;
        byDate[date].energyKwh += energyKwh;
        byDateHour[date][hour].revenue += revenue;
        byDateHour[date][hour].energyKwh += energyKwh;
        if (!perSiteByDate[key][date]) perSiteByDate[key][date] = blank();
        perSiteByDate[key][date].revenue += revenue;
        perSiteByDate[key][date].energyKwh += energyKwh;
      });
    }
  }

  return { sites, byDate, byDateHour, perSiteByDate };
}

// Convenience: totals for a single local date, plus that date's 24 hour buckets.
export async function montaForDate(token, { date, tz, siteIds }) {
  const b = await montaBuckets(token, { fromDate: date, toDate: date, tz, siteIds });
  return {
    sites: b.sites,
    totals: b.byDate[date] || { revenue: 0, energyKwh: 0 },
    hourly: b.byDateHour[date] || Array.from({ length: 24 }, () => ({ revenue: 0, energyKwh: 0 })),
    perSite: Object.fromEntries(
      Object.entries(b.perSiteByDate).map(([k, v]) => [k, v[date] || { revenue: 0, energyKwh: 0 }])
    ),
  };
}
