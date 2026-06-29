// api/today-hourly.js — hourly revenue breakdown for the intraday chart
// Fetches one org/stats call per completed hour since midnight, batched 5 at a time.
// Loaded lazily by the frontend after the fast /api/today call renders the stat cards.

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

function localHourISO(tz, dateStr, hour) {
  const offset = utcOffsetString(tz);
  if (hour >= 24) {
    const nextDay = new Intl.DateTimeFormat("en-CA", { timeZone: tz })
      .format(new Date(new Date().getTime() + 86400000));
    return `${nextDay}T00:00:00${offset}`;
  }
  return `${dateStr}T${String(hour).padStart(2, "0")}:00:00${offset}`;
}

async function revenueForWindow(token, orgId, fromISO, toISO) {
  const url = `${API_BASE}/api/v1/organization/stats?organizationId=${orgId}` +
    `&from=${encodeURIComponent(fromISO)}&to=${encodeURIComponent(toISO)}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (r.ok) return ((await r.json()).aggregateStats?.totalRevenue || 0) / 100;
    if (attempt === 0) await new Promise(res => setTimeout(res, 300));
  }
  return 0;
}

async function batchedMap(items, batchSize, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    results.push(...await Promise.all(batch.map(fn)));
  }
  return results;
}

export default async function handler(req, res) {
  try {
    const tz = process.env.EE_TIMEZONE || "America/New_York";
    const orgId = process.env.EE_ORG_ID || "77";
    const token = await getToken();
    const nowHour = parseInt(
      new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(new Date()), 10
    ) % 24;
    const dateStr = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());

    const hours = Array.from({ length: nowHour + 1 }, (_, h) => h);
    const revenues = await batchedMap(hours, 5, h =>
      revenueForWindow(token, orgId, localHourISO(tz, dateStr, h), localHourISO(tz, dateStr, h + 1))
    );

    let running = 0;
    const hourly = revenues.map((rev, h) => {
      running += rev;
      return { hour: h, revenue: Number(rev.toFixed(2)), cumulative: Number(running.toFixed(2)) };
    });

    res.setHeader("cache-control", "s-maxage=300");
    res.status(200).json({ asOfHour: nowHour, timezone: tz, hourly });
  } catch (err) {
    const code = err.code || "ERROR";
    res.status(code === "AUTH_INVALID" ? 401 : 500)
       .json({ error: String(err.message || err), code });
  }
}
