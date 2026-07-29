// ONE-TIME backfill — adds `actualKwh` to existing accuracy-log.json entries that
// predate energy tracking. Safe to run repeatedly (idempotent). DELETE AFTER USE.
//
//   GET /api/backfill-energy                    -> dry run, writes nothing
//   GET /api/backfill-energy?confirm=1          -> performs the single write
//   GET /api/backfill-energy?from=&to=&confirm=1 -> restrict the date range
//
// One org/stats call per day (midnight->midnight local). Hourly windows were
// verified exactly additive in both units on 2026-07-28 (sum of 24 == full day,
// 0.000% delta), so there is no need to fetch hour-by-hour here.
import { put, list } from "@vercel/blob";

const AUTH_URL = "https://electricera.us.auth0.com/oauth/token";
const AUDIENCE = "api.mothership.electriceratechnologies.com";
const API_BASE = "https://www.api.mothership.electriceratechnologies.com";
const MAX_SPAN_DAYS = 95;

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
  if (!r.ok) { const e = new Error("auth " + r.status); e.code = "AUTH_INVALID"; throw e; }
  return (await r.json()).access_token;
}

// Offset for a SPECIFIC date, not for now — a fixed offset would be wrong for any
// range spanning a DST boundary. This repo has shipped that bug before.
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

function addDays(dateStr, n) {
  const d = new Date(dateStr + "T12:00:00Z"); // noon anchor dodges DST edges
  d.setUTCDate(d.getUTCDate() + n);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(d);
}

async function energyForDay(token, orgId, tz, dateStr) {
  const ref = new Date(dateStr + "T12:00:00Z");
  const offset = utcOffsetString(tz, ref);
  const from = `${dateStr}T00:00:00${offset}`;
  const to = `${addDays(dateStr, 1)}T00:00:00${offset}`;
  const url = `${API_BASE}/api/v1/organization/stats?organizationId=${orgId}` +
    `&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (r.ok) {
      const agg = (await r.json()).aggregateStats;
      return {
        energyKwh: Number((agg?.totalEnergy || 0).toFixed(1)),
        revenue: Number(((agg?.totalRevenue || 0) / 100).toFixed(2)),
      };
    }
    if (attempt === 0) await new Promise(res => setTimeout(res, 300));
  }
  return null; // distinct from 0 — a failed fetch must not be written as real data
}

export default async function handler(req, res) {
  console.log(`[backfill-energy] start ${new Date().toISOString()}`);
  try {
    const tz = process.env.EE_TIMEZONE || "America/New_York";
    const orgId = process.env.EE_ORG_ID || "77";
    const confirm = req.query.confirm === "1";

    // --- Read the existing log FIRST. Abort on anything unexpected rather than
    // risk writing a truncated or empty log over 47 days of real history.
    let log;
    try {
      const { blobs } = await list({ prefix: "accuracy-log.json" });
      if (blobs.length === 0) throw new Error("accuracy-log.json does not exist");
      const r = await fetch(blobs[0].url);
      if (!r.ok) throw new Error(`fetch failed: ${r.status}`);
      log = await r.json();
    } catch (e) {
      console.error(`[backfill-energy] ABORT: cannot read accuracy-log.json — ${e.message}`);
      return res.status(500).json({ error: `cannot read accuracy-log.json: ${e.message}`, code: "LOG_READ_FAILED" });
    }
    if (!Array.isArray(log) || log.length < 40) {
      const msg = `refusing to touch a log of unexpected shape (isArray=${Array.isArray(log)}, length=${log?.length})`;
      console.error(`[backfill-energy] ABORT: ${msg}`);
      return res.status(500).json({ error: msg, code: "LOG_SHAPE_UNEXPECTED" });
    }

    const firstDate = log[0].date, lastDate = log[log.length - 1].date;
    const from = req.query.from || firstDate;
    const to = req.query.to || lastDate;
    if (from < firstDate || to > lastDate) {
      return res.status(400).json({ error: `range must sit inside the log (${firstDate}..${lastDate})`, code: "RANGE_OUT_OF_BOUNDS" });
    }
    const targets = log.filter(e => e.date >= from && e.date <= to).map(e => e.date);
    if (targets.length > MAX_SPAN_DAYS) {
      return res.status(400).json({ error: `span ${targets.length} exceeds ${MAX_SPAN_DAYS}`, code: "SPAN_TOO_LARGE" });
    }

    // --- Fetch, batched 5 at a time to match the other endpoints' rate discipline.
    const token = await getToken();
    const fetched = [];
    for (let i = 0; i < targets.length; i += 5) {
      const batch = targets.slice(i, i + 5);
      const out = await Promise.all(batch.map(async d => ({
        date: d,
        ...((await energyForDay(token, orgId, tz, d)) || { energyKwh: null }),
      })));
      fetched.push(...out);
    }
    const failed = fetched.filter(f => f.energyKwh == null).map(f => f.date);
    if (failed.length) {
      const msg = `${failed.length} day(s) failed to fetch; writing nothing: ${failed.join(", ")}`;
      console.error(`[backfill-energy] ABORT: ${msg}`);
      return res.status(502).json({ error: msg, code: "FETCH_INCOMPLETE" });
    }

    // --- Sanity cross-check: implied blended rate must be plausible.
    const byDate = new Map(fetched.map(f => [f.date, f.energyKwh]));
    const rows = log.filter(e => byDate.has(e.date));
    const sumRev = rows.reduce((s, e) => s + (e.actual || 0), 0);
    const sumKwh = rows.reduce((s, e) => s + byDate.get(e.date), 0);
    const rate = sumKwh > 0 ? sumRev / sumKwh : null;
    if (rate == null || rate < 0.35 || rate > 0.70) {
      const msg = `implausible blended rate $${rate?.toFixed(4)}/kWh (sum $${sumRev.toFixed(2)} / ${sumKwh.toFixed(1)}kWh); writing nothing`;
      console.error(`[backfill-energy] ABORT: ${msg}`);
      return res.status(500).json({ error: msg, code: "IMPLAUSIBLE_RATE" });
    }

    // --- Merge by date. log.map guarantees length, order, and every existing
    // field survive; the spread preserves snapshots/holiday/anything added later.
    const merged = log.map(e => byDate.has(e.date) ? { ...e, actualKwh: byDate.get(e.date) } : e);

    const diff = rows.map(e => ({
      date: e.date, actual: e.actual, actualKwh: byDate.get(e.date),
      impliedRate: byDate.get(e.date) > 0 ? Number((e.actual / byDate.get(e.date)).toFixed(4)) : null,
    }));
    const summary = {
      written: false,
      logEntries: log.length,
      daysMatched: rows.length,
      unmatched: [],
      blendedRate: Number(rate.toFixed(4)),
      sumRevenue: Number(sumRev.toFixed(2)),
      sumKwh: Number(sumKwh.toFixed(1)),
      range: { from, to },
      diff,
    };

    if (!confirm) {
      console.log(`[backfill-energy] dry run OK: ${rows.length} days, rate $${rate.toFixed(4)}/kWh`);
      return res.status(200).json({ ...summary, note: "dry run — pass ?confirm=1 to write" });
    }

    console.log(`[backfill-energy] writing accuracy-log.json (${merged.length} entries, ${rows.length} updated)`);
    await put("accuracy-log.json", JSON.stringify(merged), {
      access: "public",
      addRandomSuffix: false,
      contentType: "application/json",
    });
    res.status(200).json({ ...summary, written: true });
  } catch (err) {
    console.error(`[backfill-energy] ABORT: ${err.message || err}`);
    res.status(err.code === "AUTH_INVALID" ? 401 : 500)
       .json({ error: String(err.message || err), code: err.code || "ERROR" });
  }
}
