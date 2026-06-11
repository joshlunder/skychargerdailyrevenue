// TEMPORARY diagnostic — compares single-window vs summed-hourly revenue
// to determine how the EE stats endpoint attributes boundary-crossing sessions.
// DELETE after diagnosis.

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
  if (!r.ok) { const e = new Error("auth " + r.status); e.code = "AUTH_INVALID"; throw e; }
  return (await r.json()).access_token;
}

function utcOffsetString(tz, refDate) {
  const utcH = refDate.getUTCHours() + refDate.getUTCMinutes() / 60;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour: "numeric", minute: "2-digit", hour12: false,
  }).formatToParts(refDate);
  const localH = parseInt(parts.find(p => p.type === "hour").value) +
    parseInt(parts.find(p => p.type === "minute").value) / 60;
  let offset = Math.round(localH - utcH);
  if (offset > 12) offset -= 24;
  if (offset < -12) offset += 24;
  const sign = offset >= 0 ? "+" : "-";
  return `${sign}${String(Math.abs(offset)).padStart(2, "0")}:00`;
}

async function rev(token, orgId, from, to) {
  const url = `${API_BASE}/api/v1/organization/stats?organizationId=${orgId}` +
    `&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) return { error: r.status };
  const j = await r.json();
  return { revenue: (j.aggregateStats?.totalRevenue || 0) / 100, raw: j.aggregateStats };
}

export default async function handler(req, res) {
  try {
    const tz = process.env.EE_TIMEZONE || "America/Los_Angeles";
    const orgId = process.env.EE_ORG_ID || "77";
    const token = await getToken();

    const now = new Date();

    // If a date is provided (YYYY-MM-DD), compare that full day across ET/MT/PT
    // using ONE token (minimizes auth calls / rate limits).
    if (req.query.date) {
      const d = req.query.date;
      // next calendar day
      const next = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" })
        .format(new Date(new Date(d + "T00:00:00Z").getTime() + 86400000));
      const zones = { eastern: "-04:00", mountain: "-06:00", pacific: "-07:00" };
      const out = {};
      for (const [name, off] of Object.entries(zones)) {
        const r = await rev(token, orgId, `${d}T00:00:00${off}`, `${next}T00:00:00${off}`);
        out[name] = { revenue: r.revenue, sessions: r.raw?.totalSessions };
      }
      res.setHeader("cache-control", "no-store");
      return res.status(200).json({ date: d, fullDay: out });
    }

    const offset = utcOffsetString(tz, now);
    const dateStr = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now);
    const nowHour = parseInt(
      new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(now), 10
    ) % 24;

    // A) one single window: midnight -> (nowHour+1):00
    const dayStart = `${dateStr}T00:00:00${offset}`;
    const dayEnd = `${dateStr}T${String(nowHour + 1).padStart(2, "0")}:00:00${offset}`;
    const single = await rev(token, orgId, dayStart, dayEnd);

    // B) sum of hourly windows 0..nowHour
    const hourly = [];
    let hourlySum = 0;
    for (let h = 0; h <= nowHour; h++) {
      const from = `${dateStr}T${String(h).padStart(2, "0")}:00:00${offset}`;
      const to = `${dateStr}T${String(h + 1).padStart(2, "0")}:00:00${offset}`;
      const r = await rev(token, orgId, from, to);
      hourly.push({ hour: h, revenue: r.revenue });
      hourlySum += r.revenue || 0;
    }

    res.setHeader("cache-control", "no-store");
    res.status(200).json({
      tz, dateStr, nowHour, offset,
      singleWindow: { window: `${dayStart} → ${dayEnd}`, revenue: single.revenue, raw: single.raw },
      hourlySum: Number(hourlySum.toFixed(2)),
      delta: Number((single.revenue - hourlySum).toFixed(2)),
      hourly,
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err), code: err.code || "ERROR" });
  }
}
