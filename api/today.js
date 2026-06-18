// api/today.js — Vercel serverless function
// Fetches org-level revenue from Electric Era using organization/stats endpoint.
// All hourly calls run in parallel to stay well within the 30s timeout.
//
// Required environment variables:
//   EE_USERNAME   Electric Era login email
//   EE_PASSWORD   Electric Era password
//   EE_CLIENT_ID  OAuth client_id
//   EE_ORG_ID     organization ID (e.g. 77)
//   EE_TIMEZONE   IANA tz of the sites, e.g. "America/New_York"

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

// Returns revenue in dollars for a UTC ISO window using the org/stats endpoint.
// Retries once on failure to handle transient rate limits.
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

// Run async tasks in batches to avoid rate-limiting on parallel calls.
async function batchedMap(items, batchSize, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    results.push(...await Promise.all(batch.map(fn)));
  }
  return results;
}

// Revenue day: 11:30pm ET → 11:30pm ET (hour 0 = 11:30pm–12:30am, hour 23 = 10:30pm–11:30pm).

// Returns the start timestamp (ms) of the current 11:30pm-to-11:30pm revenue day.
function dayStartMs(tz) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour: "numeric", minute: "2-digit", hour12: false,
  }).formatToParts(now);
  const H = parseInt(parts.find(p => p.type === "hour").value) % 24;
  const M = parseInt(parts.find(p => p.type === "minute").value);
  const minSinceStart = ((H * 60 + M) - (23 * 60 + 30) + 1440) % 1440;
  return now.getTime() - minSinceStart * 60000;
}

// Hour index (0–23) within the current 11:30pm-to-11:30pm day.
function currentLocalHour(tz) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour: "numeric", minute: "2-digit", hour12: false,
  }).formatToParts(now);
  const H = parseInt(parts.find(p => p.type === "hour").value) % 24;
  const M = parseInt(parts.find(p => p.type === "minute").value);
  return Math.floor(((H * 60 + M) - (23 * 60 + 30) + 1440) % 1440 / 60);
}

export default async function handler(req, res) {
  try {
    const tz = process.env.EE_TIMEZONE || "America/New_York";
    const orgId = process.env.EE_ORG_ID || "77";
    const token = await getToken();
    const nowHour = currentLocalHour(tz);
    const start = dayStartMs(tz);

    // Fetch hours in batches of 5 to avoid rate-limiting, with retry on each call.
    const hours = Array.from({ length: nowHour + 1 }, (_, h) => h);
    const revenues = await batchedMap(hours, 5, h =>
      revenueForWindow(
        token, orgId,
        new Date(start + h * 3600000).toISOString(),
        new Date(start + (h + 1) * 3600000).toISOString()
      )
    );

    let running = 0;
    const hourly = revenues.map((rev, h) => {
      running += rev;
      return { hour: h, revenue: Number(rev.toFixed(2)), cumulative: Number(running.toFixed(2)) };
    });

    res.setHeader("cache-control", "s-maxage=300");
    res.status(200).json({
      asOfHour: nowHour,
      timezone: tz,
      revenueSoFar: Number(running.toFixed(2)),
      hourly,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    const code = err.code || "ERROR";
    res.status(code === "AUTH_INVALID" ? 401 : 500)
       .json({ error: String(err.message || err), code });
  }
}
