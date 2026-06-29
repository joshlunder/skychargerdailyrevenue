// api/today-sites.js — per-site revenue totals for today
// Fetches site list, then calls GET /api/v1/organization/stats?siteIds=X per site
// (same endpoint used by api/today.js, just scoped to one site at a time).
// Site calls run in parallel batches.

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

async function revenueForSite(token, siteId, fromISO, toISO) {
  const url = `${API_BASE}/api/v1/organization/stats?siteIds=${siteId}` +
    `&from=${encodeURIComponent(fromISO)}&to=${encodeURIComponent(toISO)}`;
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) return 0;
  return ((await r.json()).aggregateStats?.totalRevenue || 0) / 100;
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
    const revenues = await Promise.all(
      activeSites.map(s => revenueForSite(token, s.id, from, to))
    );

    const sites = activeSites
      .map((s, i) => ({
        id: s.id,
        name: s.name,
        revenueToday: Number(revenues[i].toFixed(2)),
      }))
      .sort((a, b) => b.revenueToday - a.revenueToday);

    res.setHeader("cache-control", "s-maxage=300");
    res.status(200).json({ sites, fetchedAt: new Date().toISOString() });
  } catch (err) {
    const code = err.code || "ERROR";
    res.status(code === "AUTH_INVALID" ? 401 : 500)
       .json({ error: String(err.message || err), code });
  }
}
