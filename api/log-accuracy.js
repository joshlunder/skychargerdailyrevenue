// Runs nightly at 5am UTC (1am ET). Logs yesterday's actual revenue alongside
// what the projection would have shown at each 2-hour snapshot through the day.
// Saves a rolling 90-day log to Blob as accuracy-log.json.

import { put, list } from "@vercel/blob";
import { readFileSync } from "fs";
import { join } from "path";

const AUTH_URL = "https://electricera.us.auth0.com/oauth/token";
const AUDIENCE = "api.mothership.electriceratechnologies.com";
const API_BASE = "https://www.api.mothership.electriceratechnologies.com";
const SNAPSHOT_HOURS = [8, 10, 12, 14, 16, 18, 20, 22];
const DOW_MAP = { Sun:"sun", Mon:"mon", Tue:"tue", Wed:"wed", Thu:"thu", Fri:"fri", Sat:"sat" };

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

export default async function handler(req, res) {
  try {
    const tz = process.env.EE_TIMEZONE || "America/New_York";
    const orgId = process.env.EE_ORG_ID || "77";
    const token = await getToken();

    // Log yesterday — it's fully complete by the time this runs (1am ET)
    const yesterdayDate = new Date(Date.now() - 86400000);
    const todayDate = new Date();
    const dateStr = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(yesterdayDate);
    const todayStr = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(todayDate);
    const wdShort = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(yesterdayDate);
    const dow = DOW_MAP[wdShort];
    const offset = utcOffsetString(tz, yesterdayDate);

    // Fetch all 24 hours of yesterday in parallel
    const hourRevenues = await Promise.all(
      Array.from({ length: 24 }, (_, h) => {
        const start = `${dateStr}T${String(h).padStart(2, "0")}:00:00${offset}`;
        const end = h === 23
          ? `${todayStr}T00:00:00${offset}`
          : `${dateStr}T${String(h + 1).padStart(2, "0")}:00:00${offset}`;
        const url = `${API_BASE}/api/v1/organization/stats?organizationId=${orgId}` +
          `&from=${encodeURIComponent(start)}&to=${encodeURIComponent(end)}`;
        return fetch(url, { headers: { authorization: `Bearer ${token}` } })
          .then(r => r.ok ? r.json() : null)
          .then(j => (j?.aggregateStats?.totalRevenue || 0) / 100)
          .catch(() => 0);
      })
    );

    const actual = Number(hourRevenues.reduce((a, b) => a + b, 0).toFixed(2));

    // Load baseline (Blob first, then bundled fallback)
    let baseline;
    try {
      const { blobs } = await list({ prefix: "baseline.json" });
      if (blobs.length > 0) {
        const r = await fetch(blobs[0].url);
        if (r.ok) baseline = await r.json();
      }
    } catch (e) {}
    if (!baseline) baseline = JSON.parse(readFileSync(join(process.cwd(), "baseline.json"), "utf8"));

    // Build cumulative profile for this DOW
    const profile = baseline.profile[dow] || baseline.profile[wdShort === "Sat" || wdShort === "Sun" ? "weekend" : "weekday"];
    const cum = [];
    let s = 0;
    for (let h = 0; h < 24; h++) { s += profile[h]; cum.push(s); }
    const fullTypical = cum[23];

    // Replay the projection model at each snapshot hour
    const snapshots = {};
    for (const snapHour of SNAPSHOT_HOURS) {
      const soFar = hourRevenues.slice(0, snapHour + 1).reduce((a, b) => a + b, 0);
      const typicalByNow = cum[snapHour];
      const pace = typicalByNow > 0 ? soFar / typicalByNow : 1;
      const confidence = typicalByNow / fullTypical;
      const blendedPace = confidence * pace + (1 - confidence) * 1.0;
      snapshots[snapHour] = Number((soFar + (fullTypical - typicalByNow) * blendedPace).toFixed(2));
    }

    // Load existing log from Blob
    let log = [];
    try {
      const { blobs } = await list({ prefix: "accuracy-log.json" });
      if (blobs.length > 0) {
        const r = await fetch(blobs[0].url);
        if (r.ok) log = await r.json();
      }
    } catch (e) {}

    // Append (deduplicate by date), keep 90 days
    log = log.filter(e => e.date !== dateStr);
    log.push({ date: dateStr, dow, actual, snapshots });
    log = log.slice(-90);

    await put("accuracy-log.json", JSON.stringify(log), {
      access: "public",
      addRandomSuffix: false,
      contentType: "application/json",
    });

    res.status(200).json({ logged: dateStr, dow, actual, snapshots });
  } catch (err) {
    res.status(err.code === "AUTH_INVALID" ? 401 : 500).json({ error: String(err.message || err), code: err.code || "ERROR" });
  }
}
