// ONE-TIME backfill — folds Monta revenue/energy into existing accuracy-log.json
// entries that predate Monta tracking. Idempotent. DELETE AFTER USE.
//
//   GET /api/backfill-monta                     -> dry run, writes nothing
//   GET /api/backfill-monta?confirm=1           -> performs the single write
//   GET /api/backfill-monta?from=&to=&confirm=1 -> restrict the date range
//
// Idempotency: unlike the earlier kWh backfill (which SET a brand-new field), this
// one changes `actual`, so a naive re-run would double-count Monta. Instead the
// EE-only original is preserved as actualEe and `actual` is always RECOMPUTED as
// actualEe + actualMonta — a set, never an increment. Re-running is a no-op.
import { put, list } from "@vercel/blob";
import { montaConfigured, montaToken, montaBuckets } from "./_monta.js";

const MAX_SPAN_DAYS = 95;

export default async function handler(req, res) {
  console.log(`[backfill-monta] start ${new Date().toISOString()}`);
  try {
    const tz = process.env.EE_TIMEZONE || "America/New_York";
    const confirm = req.query.confirm === "1";

    if (!montaConfigured()) {
      return res.status(503).json({ error: "monta not configured", code: "MONTA_UNCONFIGURED" });
    }

    // --- Read the existing log FIRST and abort on anything unexpected, rather than
    // risk writing a truncated log over ~50 days of real history.
    let log;
    try {
      const { blobs } = await list({ prefix: "accuracy-log.json" });
      if (blobs.length === 0) throw new Error("accuracy-log.json does not exist");
      const r = await fetch(blobs[0].url);
      if (!r.ok) throw new Error(`fetch failed: ${r.status}`);
      log = await r.json();
    } catch (e) {
      console.error(`[backfill-monta] ABORT: cannot read accuracy-log.json — ${e.message}`);
      return res.status(500).json({ error: `cannot read accuracy-log.json: ${e.message}`, code: "LOG_READ_FAILED" });
    }
    if (!Array.isArray(log) || log.length < 40) {
      const msg = `refusing to touch a log of unexpected shape (isArray=${Array.isArray(log)}, length=${log?.length})`;
      console.error(`[backfill-monta] ABORT: ${msg}`);
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

    // --- One padded fetch per site covers the whole window; attribution is local.
    const token = await montaToken();
    const { byDate, sites } = await montaBuckets(token, { fromDate: from, toDate: to, tz });
    console.log(`[backfill-monta] fetched ${sites.length} monta sites across ${targets.length} days`);

    // --- Merge by date. log.map guarantees length, order, and every existing field
    // (snapshots, holiday, anything added later) survive untouched.
    const seen = new Set(targets);
    const merged = log.map(e => {
      if (!seen.has(e.date)) return e;
      // Preserve the EE-only originals. On a first run these come from the current
      // combined-free `actual`; on a re-run they already exist and are reused, which
      // is what makes this idempotent.
      const actualEe = e.actualEe ?? e.actual;
      const actualKwhEe = e.actualKwhEe ?? e.actualKwh;
      const m = byDate[e.date] || { revenue: 0, energyKwh: 0 };
      const actualMonta = Number(m.revenue.toFixed(2));
      const actualKwhMonta = Number(m.energyKwh.toFixed(1));
      return {
        ...e,
        actual: Number((actualEe + actualMonta).toFixed(2)),
        actualKwh: Number((actualKwhEe + actualKwhMonta).toFixed(1)),
        actualEe, actualKwhEe, actualMonta, actualKwhMonta,
      };
    });

    // --- Sanity: the combined blended rate must stay plausible. Monta drags this
    // down (Pepsi is free), so the band is wider than the EE-only one.
    const rows = merged.filter(e => seen.has(e.date));
    const sumRev = rows.reduce((s, e) => s + e.actual, 0);
    const sumKwh = rows.reduce((s, e) => s + e.actualKwh, 0);
    const rate = sumKwh > 0 ? sumRev / sumKwh : null;
    if (rate == null || rate < 0.20 || rate > 0.70) {
      const msg = `implausible combined rate $${rate?.toFixed(4)}/kWh ($${sumRev.toFixed(2)} / ${sumKwh.toFixed(1)}kWh); writing nothing`;
      console.error(`[backfill-monta] ABORT: ${msg}`);
      return res.status(500).json({ error: msg, code: "IMPLAUSIBLE_RATE" });
    }
    // Every targeted day should have SOME Monta energy — Pepsi alone runs ~2,600
    // kWh/day. A run of zeros means the fetch silently came back empty.
    const zeroDays = rows.filter(e => e.actualKwhMonta <= 0).map(e => e.date);
    if (zeroDays.length > Math.max(3, Math.floor(rows.length * 0.15))) {
      const msg = `${zeroDays.length}/${rows.length} days have zero Monta energy; writing nothing. Sample: ${zeroDays.slice(0, 6).join(", ")}`;
      console.error(`[backfill-monta] ABORT: ${msg}`);
      return res.status(500).json({ error: msg, code: "TOO_MANY_ZERO_DAYS" });
    }

    const summary = {
      written: false,
      logEntries: log.length,
      daysUpdated: rows.length,
      montaSites: sites.map(s => s.name),
      combinedRate: Number(rate.toFixed(4)),
      sumRevenue: Number(sumRev.toFixed(2)),
      sumKwh: Number(sumKwh.toFixed(1)),
      zeroMontaDays: zeroDays,
      range: { from, to },
      diff: rows.map(e => ({
        date: e.date,
        actualEe: e.actualEe, actualMonta: e.actualMonta, actual: e.actual,
        actualKwhEe: e.actualKwhEe, actualKwhMonta: e.actualKwhMonta, actualKwh: e.actualKwh,
      })),
    };

    if (!confirm) {
      console.log(`[backfill-monta] dry run OK: ${rows.length} days, rate $${rate.toFixed(4)}/kWh`);
      return res.status(200).json({ ...summary, note: "dry run — pass ?confirm=1 to write" });
    }

    console.log(`[backfill-monta] writing accuracy-log.json (${merged.length} entries, ${rows.length} updated)`);
    await put("accuracy-log.json", JSON.stringify(merged), {
      access: "public",
      addRandomSuffix: false,
      contentType: "application/json",
    });
    res.status(200).json({ ...summary, written: true });
  } catch (err) {
    console.error(`[backfill-monta] ABORT: ${err.message || err}`);
    res.status(500).json({ error: String(err.message || err), code: err.code || "ERROR" });
  }
}
