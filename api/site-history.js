// api/site-history.js — 30-day daily revenue history for one site
// GET /api/site-history?siteId=X
// Returns { siteId, daily: [{date, revenue}] } — 30 completed days, oldest first.

const AUTH_URL = "https://electricera.us.auth0.com/oauth/token";
const AUDIENCE = "api.mothership.electriceratechnologies.com";
const API_BASE = "https://www.api.mothership.electriceratechnologies.com";

async function getToken() {
  const r = await fetch(AUTH_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      username: process.env.EE_USERNAME,
      password: process.env.EE_PASSWORD,
      client_id: process.env.EE_CLIENT_ID,
      audience: AUDIENCE,
    }),
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

// Use noon-UTC anchor to avoid DST date-boundary edge cases
function dateAtNDaysAgo(n, tz) {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - n);
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
}

// Returns both units from a single call, so siteHistoryCache serves both display
// modes and switching units needs no refetch.
async function statsForDay(token, siteId, dateStr, nextDateStr, offset) {
  const from = encodeURIComponent(`${dateStr}T00:00:00${offset}`);
  const to = encodeURIComponent(`${nextDateStr}T00:00:00${offset}`);
  const url = `${API_BASE}/api/v1/organization/stats?siteIds=${siteId}&from=${from}&to=${to}`;
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) return { revenue: 0, energyKwh: 0 };
  const agg = (await r.json()).aggregateStats;
  return {
    revenue: (agg?.totalRevenue || 0) / 100,
    energyKwh: agg?.totalEnergy || 0, // already kWh
  };
}

export default async function handler(req, res) {
  const { siteId } = req.query;
  if (!siteId) return res.status(400).json({ error: "siteId required" });

  try {
    const tz = process.env.EE_TIMEZONE || "America/New_York";
    const token = await getToken();
    const offset = utcOffsetString(tz);
    const DAYS = 30;

    // Build 30 day pairs: oldest first (30 days ago → yesterday)
    const pairs = [];
    for (let i = DAYS; i >= 1; i--) {
      pairs.push({
        date: dateAtNDaysAgo(i, tz),
        next: dateAtNDaysAgo(i - 1, tz),
      });
    }

    const perDay = await Promise.all(
      pairs.map(({ date, next }) => statsForDay(token, siteId, date, next, offset))
    );

    const daily = pairs.map(({ date }, i) => ({
      date,
      revenue: Number(perDay[i].revenue.toFixed(2)),
      energyKwh: Number(perDay[i].energyKwh.toFixed(1)),
    }));

    res.setHeader("cache-control", "s-maxage=3600");
    res.status(200).json({ siteId, daily });
  } catch (err) {
    const code = err.code || "ERROR";
    res.status(code === "AUTH_INVALID" ? 401 : 500)
       .json({ error: String(err.message || err), code });
  }
}
