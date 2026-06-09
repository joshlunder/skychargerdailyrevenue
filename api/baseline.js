// Serves the baseline profile — from Vercel Blob if available (kept fresh by
// the weekly cron), otherwise falls back to the bundled baseline.json.
// The frontend always calls this endpoint so it never needs a hardcoded blob URL.

import { list } from "@vercel/blob";
import { readFileSync } from "fs";
import { join } from "path";

export default async function handler(req, res) {
  res.setHeader("cache-control", "s-maxage=3600, stale-while-revalidate=86400");
  try {
    const { blobs } = await list({ prefix: "baseline.json" });
    if (blobs.length > 0) {
      const r = await fetch(blobs[0].url);
      if (r.ok) return res.status(200).json(await r.json());
    }
  } catch (e) { /* blob not configured or unavailable — fall through */ }
  const data = JSON.parse(readFileSync(join(process.cwd(), "baseline.json"), "utf8"));
  res.status(200).json(data);
}
