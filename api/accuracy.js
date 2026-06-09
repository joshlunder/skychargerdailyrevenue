// Serves the accuracy log from Blob, or an empty array if none exists yet.
import { list } from "@vercel/blob";

export default async function handler(req, res) {
  res.setHeader("cache-control", "s-maxage=3600, stale-while-revalidate=86400");
  try {
    const { blobs } = await list({ prefix: "accuracy-log.json" });
    if (blobs.length > 0) {
      const r = await fetch(blobs[0].url);
      if (r.ok) return res.status(200).json(await r.json());
    }
  } catch (e) {}
  res.status(200).json([]);
}
