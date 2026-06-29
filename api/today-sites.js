// api/today-sites.js — per-site revenue totals for today
// Two parallel calls:
//   GET /api/v1/site/organization/{orgId}       → site names + IDs
//   POST /api/v1/site/org/{orgId}/site_stats    → revenue per site (midnight → now)

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

export default async function handler(req, res) {
  try {
    const tz = process.env.EE_TIMEZONE || "America/New_York";
    const orgId = process.env.EE_ORG_ID || "77";
    const token = await getToken();

    const dateStr = localDateString(tz);
    const offset = utcOffsetString(tz);
    const from = `${dateStr}T00:00:00${offset}`;
    const to = new Date().toISOString();

    const [sitesResp, statsResp] = await Promise.all([
      fetch(`${API_BASE}/api/v1/site/organization/${orgId}?take=1000&skip=0`, {
        headers: { authorization: `Bearer ${token}` },
      }),
      fetch(`${API_BASE}/api/v1/site/org/${orgId}/site_stats`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify([from, to]),
      }),
    ]);

    if (!sitesResp.ok) {
      const body = await sitesResp.text().catch(() => "");
      throw new Error(`sites list failed: ${sitesResp.status} — ${body.slice(0, 200)}`);
    }
    if (!statsResp.ok) {
      const body = await statsResp.text().catch(() => "");
      throw new Error(`site stats failed: ${statsResp.status} — ${body.slice(0, 200)}`);
    }

    const sitesData = await sitesResp.json();
    const statsArray = await statsResp.json();
    const siteRevenueStats = statsArray[0]?.siteRevenueStats ?? [];

    const revenueById = Object.fromEntries(
      siteRevenueStats.map(s => [s.id, s.revenueAmount / (s.precision || 100)])
    );

    const sites = sitesData
      .filter(s => s.active)
      .map(s => ({
        id: s.id,
        name: s.name,
        revenueToday: Number((revenueById[s.id] ?? 0).toFixed(2)),
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
