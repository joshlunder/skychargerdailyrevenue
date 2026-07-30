// api/today-sites.js — per-site revenue totals for today
// Fetches site list, then calls GET /api/v1/organization/stats?siteIds=X per site
// (same endpoint used by api/today.js, just scoped to one site at a time).
// Site calls run in parallel batches.

import { montaConfigured, montaToken, montaForDate, MONTA_PREFIX } from "./_monta.js";

const AUTH_URL = "https://electricera.us.auth0.com/oauth/token";
const AUDIENCE = "api.mothership.electriceratechnologies.com";
const API_BASE = "https://www.api.mothership.electriceratechnologies.com";

async function getToken() {
  const body = new URLSearchParams({
    grant_type: "password",
    username: process.env.EE_USERNAME,
    password: process.env.EE_PASSWORD,
    client_id: process.env.EE_CLIENT_ID,
    audience: AUDIENCE,
  });
  const r = await fetch(AUTH_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) {
    const e = new Error("auth failed: " + r.status);
    e.code = (r.status === 401 || r.status === 403) ? "AUTH_INVALID" : "AUTH_ERROR";
    throw e;
  }
  return (await r.json()).access_token;
}

function utcOffsetString(tz) {
  const now = new Date();
  const utcH = now.getUTCHours() + now.getUTCMinutes() / 60;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour: "numeric", minute: "2-digit", hour12: false,
  }).formatToParts(now);
  const localH = parseInt(parts.find(p => p.type === "hour").value) +
    parseInt(parts.find(p => p.type === "minute").value) / 60;
  let offset = Math.round(localH - utcH);
  if (offset > 12) offset -= 24;
  if (offset < -12) offset += 24;
  const sign = offset >= 0 ? "+" : "-";
  return `${sign}${String(Math.abs(offset)).padStart(2, "0")}:00`;
}

function localDateString(tz) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
}

function currentLocalHour(tz) {
  const h = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour: "numeric", hour12: false,
  }).format(new Date());
  return parseInt(h, 10) % 24;
}

// Returns both units from a single call — totalEnergy rides along in the same
// response as totalRevenue, so kWh costs zero additional API calls.
async function statsForSite(token, siteId, fromISO, toISO) {
  const url = `${API_BASE}/api/v1/organization/stats?siteIds=${siteId}` +
    `&from=${encodeURIComponent(fromISO)}&to=${encodeURIComponent(toISO)}`;
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) return { revenue: 0, energyKwh: 0 };
  const agg = (await r.json()).aggregateStats;
  return {
    revenue: (agg?.totalRevenue || 0) / 100,
    energyKwh: agg?.totalEnergy || 0, // already kWh
  };
}

// Monta's CA sites with today's totals, never throwing.
async function montaSitesSafe(tz, dateStr) {
  if (!montaConfigured()) return { sites: [], ok: false, error: "not configured" };
  try {
    const token = await montaToken();
    const { sites, perSite } = await montaForDate(token, { date: dateStr, tz });
    return {
      ok: true,
      sites: sites.map(s => {
        const key = `${MONTA_PREFIX}:${s.id}`;
        const v = perSite[key] || { revenue: 0, energyKwh: 0 };
        return {
          id: key,
          provider: "monta",
          name: s.name,
          revenueToday: Number(v.revenue.toFixed(2)),
          energyToday: Number(v.energyKwh.toFixed(1)),
        };
      }),
    };
  } catch (e) {
    console.error(`[today-sites] monta failed: ${e.message || e}`);
    return { sites: [], ok: false, error: String(e.message || e) };
  }
}

export default async function handler(req, res) {
  try {
    const tz = process.env.EE_TIMEZONE || "America/New_York";
    const orgId = process.env.EE_ORG_ID || "77";
    const token = await getToken();

    const dateStr = localDateString(tz);
    const offset = utcOffsetString(tz);
    const nowHour = currentLocalHour(tz);

    const from = `${dateStr}T00:00:00${offset}`;
    // to = end of current hour (matches how today.js accumulates)
    const toHour = Math.min(nowHour + 1, 24);
    const to = toHour < 24
      ? `${dateStr}T${String(toHour).padStart(2, "0")}:00:00${offset}`
      : (() => {
          const d = new Date(new Date().getTime() + 86400000);
          const next = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
          return `${next}T00:00:00${offset}`;
        })();

    // Get site list
    const sitesResp = await fetch(`${API_BASE}/api/v1/site/list/${orgId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!sitesResp.ok) {
      const body = await sitesResp.text().catch(() => "");
      throw new Error(`sites list failed: ${sitesResp.status} — ${body.slice(0, 200)}`);
    }
    const sitesData = await sitesResp.json();
    const sitesList = Array.isArray(sitesData) ? sitesData : (sitesData.sites ?? []);
    const activeSites = sitesList.filter(s => s.active !== false);

    // Fetch revenue per site in parallel (all at once — typically <15 sites)
    const perSite = await Promise.all(
      activeSites.map(s => statsForSite(token, s.id, from, to))
    );

    // IDs are namespaced by provider ("ee:190" / "monta:816716"). This prevents a
    // cache collision in the frontend's siteHistoryCache, and doubles as the
    // provider router for /api/site-history and the provider-toggle filter.
    const eeSites = activeSites.map((s, i) => ({
      id: `ee:${s.id}`,
      provider: "ee",
      name: s.name,
      revenueToday: Number(perSite[i].revenue.toFixed(2)),
      energyToday: Number(perSite[i].energyKwh.toFixed(1)),
    }));

    const monta = await montaSitesSafe(tz, dateStr);

    const sites = [...eeSites, ...monta.sites]
      .sort((a, b) => b.revenueToday - a.revenueToday);

    res.setHeader("cache-control", "s-maxage=300");
    res.status(200).json({
      sites,
      providers: { ee: { ok: true }, monta: { ok: monta.ok, error: monta.error } },
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    const code = err.code || "ERROR";
    res.status(code === "AUTH_INVALID" ? 401 : 500)
       .json({ error: String(err.message || err), code });
  }
}
