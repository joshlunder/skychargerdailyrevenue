// api/today.js — fast single-call revenue snapshot
// One org/stats call from midnight ET to now. Returns revenueSoFar + asOfHour only.
// Hourly breakdown for the intraday chart is fetched separately by /api/today-hourly.

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

function currentLocalHour(tz) {
  const h = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour: "numeric", hour12: false,
  }).format(new Date());
  return parseInt(h, 10) % 24;
}

export default async function handler(req, res) {
  try {
    const tz = process.env.EE_TIMEZONE || "America/New_York";
    const orgId = process.env.EE_ORG_ID || "77";
    const token = await getToken();

    const dateStr = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
    const offset = utcOffsetString(tz);
    const midnight = `${dateStr}T00:00:00${offset}`;
    const nowISO = new Date().toISOString();

    const url = `${API_BASE}/api/v1/organization/stats?organizationId=${orgId}` +
      `&from=${encodeURIComponent(midnight)}&to=${encodeURIComponent(nowISO)}`;
    const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!r.ok) {
      const e = new Error("stats failed: " + r.status);
      e.code = r.status === 401 || r.status === 403 ? "AUTH_INVALID" : "STATS_ERROR";
      throw e;
    }
    const data = await r.json();
    const revenueSoFar = (data.aggregateStats?.totalRevenue || 0) / 100;

    res.setHeader("cache-control", "s-maxage=300");
    res.status(200).json({
      asOfHour: currentLocalHour(tz),
      timezone: tz,
      revenueSoFar: Number(revenueSoFar.toFixed(2)),
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    const code = err.code || "ERROR";
    res.status(code === "AUTH_INVALID" ? 401 : 500)
       .json({ error: String(err.message || err), code });
  }
}
