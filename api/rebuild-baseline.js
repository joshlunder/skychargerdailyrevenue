import { put } from "@vercel/blob";

const AUTH_URL = "https://electricera.us.auth0.com/oauth/token";
const AUDIENCE = "api.mothership.electriceratechnologies.com";
const API_BASE = "https://www.api.mothership.electriceratechnologies.com";
const WINDOW_DAYS = 35;
const RECENT_DAYS = 14;
const RECENT_WEIGHT = 3;

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

const DOW_MAP = { Sun: "sun", Mon: "mon", Tue: "tue", Wed: "wed", Thu: "thu", Fri: "fri", Sat: "sat" };

function dayOfWeek(tz, daysAgo) {
  const base = new Date(Date.now() - daysAgo * 86400000);
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(base);
  return { dow: DOW_MAP[wd], isWeekend: wd === "Sat" || wd === "Sun" };
}

function nthWeekday(year, month, weekday, n) {
  // Returns date string for the nth occurrence of a weekday (0=Sun) in a given month.
  const d = new Date(Date.UTC(year, month - 1, 1));
  let count = 0;
  while (true) {
    if (d.getUTCDay() === weekday) { count++; if (count === n) break; }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(d);
}

function lastWeekday(year, month, weekday) {
  // Returns date string for the last occurrence of a weekday (0=Sun) in a given month.
  const d = new Date(Date.UTC(year, month, 0)); // last day of month
  while (d.getUTCDay() !== weekday) d.setUTCDate(d.getUTCDate() - 1);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(d);
}

// Offsets a "YYYY-MM-DD" string by N days (positive or negative) using real date
// arithmetic, so month/year rollovers (e.g. Dec 31 + 1 day → Jan 1) are always correct.
function addDaysToDateStr(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(d);
}

function isHoliday(dateStr) {
  const [year] = dateStr.split("-").map(Number);
  const d = dateStr.slice(5); // "MM-DD"

  // Fixed-date holidays plus their adjacent travel days. Year-agnostic month-day
  // checks — always correct, no year arithmetic needed.
  const fixedDates = new Set([
    "07-03", "07-04", "07-05", // day before/after Independence Day
    "12-23", "12-24",          // day before Christmas Eve, Christmas Eve
    "12-25", "12-26", "12-27", "12-28", "12-29", "12-30", // Christmas + 6-day block to NYE
    "12-31",                   // New Year's Eve
    "01-01",                   // New Year's Day
  ]);
  if (fixedDates.has(d)) return true;

  // Moving holidays are defined by day-of-week-of-month, so their weekday never
  // changes year to year — adjacent-day offsets are fixed day-counts from the
  // holiday's own (already year-correct) date, same technique as Black Friday below.
  const memorialDay = lastWeekday(year, 5, 1); // last Monday of May
  const laborDay = nthWeekday(year, 9, 1, 1);  // 1st Monday of September
  const thanksgiving = nthWeekday(year, 11, 4, 4); // 4th Thursday of November

  const movingHolidayDates = new Set([
    addDaysToDateStr(memorialDay, -3), memorialDay, addDaysToDateStr(memorialDay, 1), // Fri before, Memorial Day, Tue after
    addDaysToDateStr(laborDay, -3), laborDay, addDaysToDateStr(laborDay, 1),           // Fri before, Labor Day, Tue after
    addDaysToDateStr(thanksgiving, -1), thanksgiving,                                 // Wed before, Thanksgiving
    addDaysToDateStr(thanksgiving, 1), addDaysToDateStr(thanksgiving, 3),             // Black Friday, Sun after
  ]);

  // July 4th is a fixed date but its weekday moves every year. When it lands on a
  // Saturday, the federal "observed" holiday shifts to the following Monday — the
  // same convention the US government uses for weekend holidays — and that Monday
  // is a real return-travel day the plain +/-1-day window above doesn't reach.
  // (Sunday landings don't need this: the existing "day after" already covers Monday.)
  const july4 = `${year}-07-04`;
  const july4Dow = new Date(july4 + "T00:00:00Z").getUTCDay(); // 0=Sun..6=Sat
  if (july4Dow === 6) movingHolidayDates.add(addDaysToDateStr(july4, 2)); // Sat -> observed Monday

  if (movingHolidayDates.has(dateStr)) return true;

  return false;
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
  console.log(`[rebuild-baseline] start ${new Date().toISOString()}`);
  try {
    const tz = process.env.EE_TIMEZONE || "America/New_York";
    const orgId = process.env.EE_ORG_ID || "77";
    const token = await getToken();
    console.log("[rebuild-baseline] auth token obtained");

    const DAYS = ["all", "weekday", "weekend", "mon", "tue", "wed", "thu", "fri", "sat", "sun"];
    const buckets = Object.fromEntries(DAYS.map(k => [k, Array(24).fill(0)]));
    const bucketsKwh = Object.fromEntries(DAYS.map(k => [k, Array(24).fill(0)]));
    // Weight counts are shared — same days, same holiday exclusions, both units.
    const wdays = Object.fromEntries(DAYS.map(k => [k, 0]));

    for (let d = 1; d <= WINDOW_DAYS; d++) {
      const refDate = new Date(Date.now() - d * 86400000);
      const dateStr = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(refDate);

      if (isHoliday(dateStr)) continue;

      const { dow, isWeekend } = dayOfWeek(tz, d);
      const wk = isWeekend ? "weekend" : "weekday";
      const weight = d <= RECENT_DAYS ? RECENT_WEIGHT : 1;
      wdays.all += weight; wdays[wk] += weight; wdays[dow] += weight;

      const nextDate = new Date(Date.now() - (d - 1) * 86400000);
      const nextDateStr = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(nextDate);
      const offset = utcOffsetString(tz, refDate);
      const hours = Array.from({ length: 24 }, (_, h) => h);
      const hourStats = [];
      for (let i = 0; i < hours.length; i += 5) {
        const batch = hours.slice(i, i + 5);
        const results = await Promise.all(batch.map(async h => {
          const start = `${dateStr}T${String(h).padStart(2, "0")}:00:00${offset}`;
          const end = h === 23
            ? `${nextDateStr}T00:00:00${offset}`
            : `${dateStr}T${String(h + 1).padStart(2, "0")}:00:00${offset}`;
          const url = `${API_BASE}/api/v1/organization/stats?organizationId=${orgId}` +
            `&from=${encodeURIComponent(start)}&to=${encodeURIComponent(end)}`;
          for (let attempt = 0; attempt < 2; attempt++) {
            const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
            if (r.ok) {
              const agg = (await r.json()).aggregateStats;
              return {
                revenue: (agg?.totalRevenue || 0) / 100,
                energyKwh: agg?.totalEnergy || 0, // already kWh
              };
            }
            if (attempt === 0) await new Promise(res => setTimeout(res, 300));
          }
          return { revenue: 0, energyKwh: 0 };
        }));
        hourStats.push(...results);
      }
      hourStats.forEach(({ revenue, energyKwh }, h) => {
        buckets.all[h] += revenue * weight;
        buckets[wk][h] += revenue * weight;
        buckets[dow][h] += revenue * weight;
        bucketsKwh.all[h] += energyKwh * weight;
        bucketsKwh[wk][h] += energyKwh * weight;
        bucketsKwh[dow][h] += energyKwh * weight;
      });
    }

    console.log(`[rebuild-baseline] fetched ${WINDOW_DAYS} days of hourly data`);

    const profile = {};
    const profileEnergy = {};
    for (const k of DAYS) {
      profile[k] = buckets[k].map(v => Number((v / Math.max(1, wdays[k])).toFixed(2)));
      profileEnergy[k] = bucketsKwh[k].map(v => Number((v / Math.max(1, wdays[k])).toFixed(2)));
    }
    const out = {
      meta: { source: `rolling ${WINDOW_DAYS} days (recency-weighted: last ${RECENT_DAYS}d at ${RECENT_WEIGHT}x, holidays excluded)`, generated: new Date().toISOString(), days: WINDOW_DAYS },
      profile,
      profileEnergy,
    };

    // Sanity gate before a destructive overwrite. This endpoint writes with
    // addRandomSuffix:false and Blob keeps no version history, so a run that
    // silently returned mostly zeros (EE outage, auth edge case) would replace a
    // good baseline with a bad one and skew the dashboard's headline number until
    // the next Monday. Refuse to write anything that fails a floor check.
    const revSum = profile.all.reduce((a, b) => a + b, 0);
    const kwhSum = profileEnergy.all.reduce((a, b) => a + b, 0);
    const allFinite = [...Object.values(profile), ...Object.values(profileEnergy)]
      .every(arr => arr.length === 24 && arr.every(Number.isFinite));
    if (!allFinite || revSum < 500 || kwhSum < 1000) {
      const msg = `refusing to write implausible baseline: revenue/day=$${revSum.toFixed(2)}, energy/day=${kwhSum.toFixed(1)}kWh, allFinite=${allFinite}`;
      console.error(`[rebuild-baseline] ABORT: ${msg}`);
      return res.status(500).json({ error: msg, code: "IMPLAUSIBLE_BASELINE", profile, profileEnergy });
    }

    console.log(`[rebuild-baseline] guard passed (revenue/day=$${revSum.toFixed(2)}, energy/day=${kwhSum.toFixed(1)}kWh); writing baseline.json`);
    const { url } = await put("baseline.json", JSON.stringify(out), {
      access: "public",
      addRandomSuffix: false,
      contentType: "application/json",
    });
    out.blobUrl = url;
    out.persisted = true;

    res.status(200).json(out);
  } catch (err) {
    console.error(`[rebuild-baseline] ABORT: ${err.message || err}`);
    res.status(err.code === "AUTH_INVALID" ? 401 : 500).json({ error: String(err.message || err), code: err.code || "ERROR" });
  }
}
