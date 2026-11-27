/**
 * Normalize user-supplied tracker URLs. Only plain HTTP(S) is supported; UDP
 * trackers cannot be reached from Workers without a UDP socket.
 */
export function normalizeTrackerUrls(input: unknown): string[] {
  const values: string[] = [];
  if (Array.isArray(input)) {
    for (const value of input) if (typeof value === "string") values.push(value);
  } else if (typeof input === "string") {
    values.push(...input.split(/[\s,]+/));
  }

  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const value = raw.trim();
    if (!value || !/^https?:\/\//i.test(value)) continue;
    try {
      const url = new URL(value);
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      if (!url.hostname) continue;
      if (!seen.has(url.toString())) {
        seen.add(url.toString());
        out.push(url.toString());
      }
    } catch {
      continue;
    }
    if (out.length >= 20) break;
  }
  return out;
}
