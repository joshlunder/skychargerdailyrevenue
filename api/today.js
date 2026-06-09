// api/today.js — Vercel serverless function
// Fetches org-level revenue from Electric Era using organization/stats endpoint.
// All hourly calls run in parallel to stay well within the 30s timeout.
//
// Required environment variables:
//   EE_USERNAME   Electric Era login email
//   EE_PASSWORD   Electric Era password
//   EE_CLIENT_ID  OAuth client_id
//   EE_ORG_ID     organization ID (e.g. 77)
//   EE_TIMEZONE   IANA tz of the sites, e.g. "America/Los_Angeles"

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
async function revenueForWindow(token, orgId, fromISO, toISO) {
  const url = `${API_BASE}/api/v1/organization/stats?organizationId=${orgId}` +
    `&from=${encodeURIComponent(fromISO)}&to=${encodeURIComponent(toISO)}`;
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`stats call failed (${r.status})`);
  const j = await r.json();
  return (j.aggregateStats?.totalRevenue || 0) / 100; // cents → dollars
}

// UTC offset string for the timezone right now, e.g. "-07:00"
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

// ISO string for a given local hour, including tz offset.
// For hour 24 (end of day), rolls to next day midnight to avoid zero-length windows.
function localHourISO(tz, dateStr, hour) {
  const offset = utcOffsetString(tz);
  if (hour >= 24) {
    const nextDay = new Intl.DateTimeFormat("en-CA", { timeZone: tz })
      .format(new Date(new Date().getTime() + 86400000));
    return `${nextDay}T00:00:00${offset}`;
  }
  return `${dateStr}T${String(hour).padStart(2, "0")}:00:00${offset}`;
}

// Today's date string in the site timezone, e.g. "2026-06-05"
function localDateString(tz) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
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
    const nowHour = currentLocalHour(tz);
    const dateStr = localDateString(tz);

    // Fetch all hours in parallel to stay within 30s timeout
    const hours = Array.from({ length: nowHour + 1 }, (_, h) => h);
    const revenues = await Promise.all(
      hours.map(h =>
        revenueForWindow(token, orgId, localHourISO(tz, dateStr, h), localHourISO(tz, dateStr, h + 1))
          .catch(() => 0)
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
