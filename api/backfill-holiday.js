// One-time backfill — logs a specific past holiday's actual revenue into
// accuracy-log.json, using the same logic log-accuracy.js now uses going forward.
// DELETE THIS FILE after running once.
import { put, list } from "@vercel/blob";

const AUTH_URL = "https://electricera.us.auth0.com/oauth/token";
const AUDIENCE = "api.mothership.electriceratechnologies.com";
const API_BASE = "https://www.api.mothership.electriceratechnologies.com";
const SNAPSHOT_HOURS = [8, 10, 12, 14, 16, 18, 20, 22];
const DOW_MAP = { Sun:"sun", Mon:"mon", Tue:"tue", Wed:"wed", Thu:"thu", Fri:"fri", Sat:"sat" };

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
    const dateStr = req.query.date; // e.g. "2026-07-04"
    if (!dateStr) return res.status(400).json({ error: "?date=YYYY-MM-DD required" });

    const tz = process.env.EE_TIMEZONE || "America/New_York";
    const orgId = process.env.EE_ORG_ID || "77";
    const token = await getToken();

    const refDate = new Date(dateStr + "T12:00:00Z"); // noon UTC anchor, safe for tz conversion
    const nextDate = new Date(refDate.getTime() + 86400000);
    const nextDateStr = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(nextDate);
    const wdShort = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(refDate);
    const dow = DOW_MAP[wdShort];
    const offset = utcOffsetString(tz, refDate);

    const hourRevenues = [];
    for (let i = 0; i < 24; i += 5) {
      const batch = Array.from({ length: Math.min(5, 24 - i) }, (_, j) => i + j);
      const results = await Promise.all(batch.map(async h => {
        const start = `${dateStr}T${String(h).padStart(2, "0")}:00:00${offset}`;
        const end = h === 23
          ? `${nextDateStr}T00:00:00${offset}`
          : `${dateStr}T${String(h + 1).padStart(2, "0")}:00:00${offset}`;
        const url = `${API_BASE}/api/v1/organization/stats?organizationId=${orgId}` +
          `&from=${encodeURIComponent(start)}&to=${encodeURIComponent(end)}`;
        for (let attempt = 0; attempt < 2; attempt++) {
          const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
          if (r.ok) return ((await r.json()).aggregateStats?.totalRevenue || 0) / 100;
          if (attempt === 0) await new Promise(res => setTimeout(res, 300));
        }
        return 0;
      }));
      hourRevenues.push(...results);
    }
    const actual = Number(hourRevenues.reduce((a, b) => a + b, 0).toFixed(2));

    // Load baseline for snapshot replay
    const { blobs: baselineBlobs } = await list({ prefix: "baseline.json" });
    const baseline = await (await fetch(baselineBlobs[0].url)).json();
    const profile = baseline.profile[dow] || baseline.profile.all;
    const cum = [];
    let s = 0;
    for (let h = 0; h < 24; h++) { s += profile[h]; cum.push(s); }
    const fullTypical = cum[23];
    const snapshots = {};
    for (const snapHour of SNAPSHOT_HOURS) {
      const soFar = hourRevenues.slice(0, snapHour + 1).reduce((a, b) => a + b, 0);
      const typicalByNow = cum[snapHour];
      const pace = typicalByNow > 0 ? soFar / typicalByNow : 1;
      const confidence = typicalByNow / fullTypical;
      const blendedPace = confidence * pace + (1 - confidence) * 1.0;
      snapshots[snapHour] = Number((soFar + (fullTypical - typicalByNow) * blendedPace).toFixed(2));
    }

    // Load existing log, insert this entry (dedup by date), re-sort by date, write back
    const { blobs: logBlobs } = await list({ prefix: "accuracy-log.json" });
    let log = logBlobs.length > 0 ? await (await fetch(logBlobs[0].url)).json() : [];
    log = log.filter(e => e.date !== dateStr);
    log.push({ date: dateStr, dow, actual, snapshots, holiday: true });
    log.sort((a, b) => a.date.localeCompare(b.date));
    log = log.slice(-90);

    await put("accuracy-log.json", JSON.stringify(log), {
      access: "public",
      addRandomSuffix: false,
      contentType: "application/json",
    });

    res.status(200).json({ backfilled: dateStr, dow, actual, snapshots, totalEntries: log.length });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
}
