import { put } from "@vercel/blob";

const AUTH_URL = "https://electricera.us.auth0.com/oauth/token";
const AUDIENCE = "api.mothership.electriceratechnologies.com";
const API_BASE = "https://www.api.mothership.electriceratechnologies.com";
const WINDOW_DAYS = 35;

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

function isHoliday(dateStr) {
  const [year, month, day] = dateStr.split("-").map(Number);
  const d = `${month.toString().padStart(2,"0")}-${day.toString().padStart(2,"0")}`;
  // Fixed-date holidays
  if (d === "07-04") return true; // Independence Day
  if (d === "12-24") return true; // Christmas Eve
  if (d === "12-25") return true; // Christmas
  // Memorial Day — last Monday of May
  if (lastWeekday(year, 5, 1) === dateStr) return true;
  // Labor Day — 1st Monday of September
  if (nthWeekday(year, 9, 1, 1) === dateStr) return true;
  // Thanksgiving — 4th Thursday of November
  if (nthWeekday(year, 11, 4, 4) === dateStr) return true;
  // Black Friday — day after Thanksgiving
  const thanksgiving = nthWeekday(year, 11, 4, 4);
  const blackFriday = new Intl.DateTimeFormat("en-CA").format(
    new Date(new Date(thanksgiving).getTime() + 86400000)
  );
  if (blackFriday === dateStr) return true;
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
  try {
    const tz = process.env.EE_TIMEZONE || "America/New_York";
    const orgId = process.env.EE_ORG_ID || "77";
    const token = await getToken();

    const DAYS = ["all", "weekday", "weekend", "mon", "tue", "wed", "thu", "fri", "sat", "sun"];
    const buckets = Object.fromEntries(DAYS.map(k => [k, Array(24).fill(0)]));
    const ndays = Object.fromEntries(DAYS.map(k => [k, 0]));

    for (let d = 1; d <= WINDOW_DAYS; d++) {
      const refDate = new Date(Date.now() - d * 86400000);
      const nextDate = new Date(Date.now() - (d - 1) * 86400000);
      const dateStr = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(refDate);
      const nextDateStr = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(nextDate);

      if (isHoliday(dateStr)) continue;

      const { dow, isWeekend } = dayOfWeek(tz, d);
      const wk = isWeekend ? "weekend" : "weekday";
      ndays.all++; ndays[wk]++; ndays[dow]++;

      const offset = utcOffsetString(tz, refDate);
      const hourRevenues = await Promise.all(
        Array.from({ length: 24 }, (_, h) => {
          const start = `${dateStr}T${String(h).padStart(2, "0")}:00:00${offset}`;
          const end = h === 23
            ? `${nextDateStr}T00:00:00${offset}`
            : `${dateStr}T${String(h + 1).padStart(2, "0")}:00:00${offset}`;
          const url = `${API_BASE}/api/v1/organization/stats?organizationId=${orgId}` +
            `&from=${encodeURIComponent(start)}&to=${encodeURIComponent(end)}`;
          return fetch(url, { headers: { authorization: `Bearer ${token}` } })
            .then(r => r.ok ? r.json() : null)
            .then(j => (j?.aggregateStats?.totalRevenue || 0) / 100)
            .catch(() => 0);
        })
      );
      hourRevenues.forEach((dollars, h) => {
        buckets.all[h] += dollars;
        buckets[wk][h] += dollars;
        buckets[dow][h] += dollars;
      });
    }

    const profile = {};
    for (const k of DAYS) {
      profile[k] = buckets[k].map(v => Number((v / Math.max(1, ndays[k])).toFixed(2)));
    }
    const out = {
      meta: { source: `rolling ${WINDOW_DAYS} days (auto, holidays excluded)`, generated: new Date().toISOString(), days: WINDOW_DAYS },
      profile,
    };

    const { url } = await put("baseline.json", JSON.stringify(out), {
      access: "public",
      addRandomSuffix: false,
      contentType: "application/json",
    });
    out.blobUrl = url;
    out.persisted = true;

    res.status(200).json(out);
  } catch (err) {
    res.status(err.code === "AUTH_INVALID" ? 401 : 500).json({ error: String(err.message || err), code: err.code || "ERROR" });
  }
}
