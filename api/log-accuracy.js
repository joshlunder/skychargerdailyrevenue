// Runs nightly at 9am UTC (5am ET, after midnight in both EDT/EST). Logs yesterday's actual revenue alongside
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

function nthWeekday(year, month, weekday, n) {
  const d = new Date(Date.UTC(year, month - 1, 1));
  let count = 0;
  while (true) {
    if (d.getUTCDay() === weekday) { count++; if (count === n) break; }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(d);
}

function lastWeekday(year, month, weekday) {
  const d = new Date(Date.UTC(year, month, 0));
  while (d.getUTCDay() !== weekday) d.setUTCDate(d.getUTCDate() - 1);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(d);
}

function isHoliday(dateStr) {
  const [year, month, day] = dateStr.split("-").map(Number);
  const d = `${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
  if (d === "07-04") return true;
  if (d === "12-24") return true;
  if (d === "12-25") return true;
  if (d === "12-31") return true;
  if (lastWeekday(year, 5, 1) === dateStr) return true;
  if (nthWeekday(year, 9, 1, 1) === dateStr) return true;
  if (nthWeekday(year, 11, 4, 4) === dateStr) return true;
  const thanksgiving = nthWeekday(year, 11, 4, 4);
  const blackFriday = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(
    new Date(new Date(thanksgiving + "T00:00:00Z").getTime() + 86400000)
  );
  if (blackFriday === dateStr) return true;
  return false;
}

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
  console.log(`[log-accuracy] start ${new Date().toISOString()}`);
  try {
    const tz = process.env.EE_TIMEZONE || "America/New_York";
    const orgId = process.env.EE_ORG_ID || "77";
    const token = await getToken();
    console.log("[log-accuracy] auth token obtained");

    // Log yesterday — it's fully complete by the time this runs (5am ET)
    const yesterdayDate = new Date(Date.now() - 86400000);
    const todayDate = new Date();
    const dateStr = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(yesterdayDate);
    const todayStr = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(todayDate);
    const wdShort = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(yesterdayDate);
    const dow = DOW_MAP[wdShort];
    const holiday = isHoliday(dateStr);

    const offset = utcOffsetString(tz, yesterdayDate);

    // Fetch all 24 hours of yesterday in batches of 5 to avoid rate-limiting.
    const hourRevenues = [];
    for (let i = 0; i < 24; i += 5) {
      const batch = Array.from({ length: Math.min(5, 24 - i) }, (_, j) => i + j);
      const results = await Promise.all(batch.map(async h => {
        const start = `${dateStr}T${String(h).padStart(2, "0")}:00:00${offset}`;
        const end = h === 23
          ? `${todayStr}T00:00:00${offset}`
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
    console.log(`[log-accuracy] fetched ${hourRevenues.length} hours for ${dateStr}, actual=$${actual}${holiday ? " (holiday)" : ""}`);

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

    // Load existing log from Blob. If a blob exists but can't be read, abort instead
    // of silently falling back to an empty log — that would overwrite 90 days of
    // real history with a single entry.
    let log = [];
    try {
      const { blobs } = await list({ prefix: "accuracy-log.json" });
      if (blobs.length > 0) {
        const r = await fetch(blobs[0].url);
        if (!r.ok) throw new Error(`fetch failed: ${r.status}`);
        log = await r.json();
      }
    } catch (e) {
      console.error(`[log-accuracy] ABORT: failed to read existing accuracy-log.json — ${e.message}`);
      return res.status(500).json({ error: "failed to read existing accuracy-log.json, aborted to avoid data loss", code: "LOG_READ_FAILED" });
    }

    // Append (deduplicate by date), keep 90 days. Holidays are still logged (so
    // actual revenue is visible in history/charts) but flagged — they're excluded
    // from the baseline calculation (rebuild-baseline.js) since they'd skew what
    // "typical" looks like, but that doesn't mean the day itself should be invisible.
    log = log.filter(e => e.date !== dateStr);
    log.push({ date: dateStr, dow, actual, snapshots, ...(holiday ? { holiday: true } : {}) });
    log = log.slice(-90);

    console.log(`[log-accuracy] writing accuracy-log.json (${log.length} entries)`);
    await put("accuracy-log.json", JSON.stringify(log), {
      access: "public",
      addRandomSuffix: false,
      contentType: "application/json",
    });

    res.status(200).json({ logged: dateStr, dow, actual, snapshots, holiday });
  } catch (err) {
    console.error(`[log-accuracy] ABORT: ${err.message || err}`);
    res.status(err.code === "AUTH_INVALID" ? 401 : 500).json({ error: String(err.message || err), code: err.code || "ERROR" });
  }
}
