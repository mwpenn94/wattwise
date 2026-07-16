/**
 * Client-side helpers for WattWise UI.
 * decimateForChart is the BUILD-010.3 peak-preserving decimation, reused per
 * owner constraint (see shared/build0103.ts port — logic identical).
 */

export interface ChartPoint {
  ts: number;
  usage: number;
  demand: number | null;
  durationMin: number;
}

/**
 * BUILD-010.3 peak-preserving decimation (verbatim logic):
 * bucket the series into `maxPoints` buckets; from each bucket keep the point
 * with max demand (fallback max usage) so demand peaks are never lost, and
 * also keep the bucket's first point for shape continuity when it differs.
 */
export function decimateForChart(points: ChartPoint[], maxPoints = 2000): ChartPoint[] {
  if (points.length <= maxPoints) return points;
  const bucketSize = Math.ceil(points.length / maxPoints);
  const out: ChartPoint[] = [];
  for (let i = 0; i < points.length; i += bucketSize) {
    const bucket = points.slice(i, i + bucketSize);
    let peak = bucket[0];
    for (const p of bucket) {
      const pv = p.demand ?? p.usage;
      const bv = peak.demand ?? peak.usage;
      if (pv > bv) peak = p;
    }
    const first = bucket[0];
    if (first !== peak && out[out.length - 1] !== first) out.push(first);
    out.push(peak);
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/* ---------- formatting ---------- */
export function fmtNum(n: number | null | undefined, digits = 0): string {
  if (n == null || !isFinite(n)) return "—";
  return n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

export function fmtUsd(n: number | null | undefined, digits = 0): string {
  if (n == null || !isFinite(n)) return "—";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

export function fmtDate(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function fmtDateTime(ts: number): string {
  return new Date(ts).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export const CONFIDENCE_COLORS: Record<string, string> = {
  low: "text-amber-500",
  medium: "text-sky-500",
  high: "text-emerald-500",
};

/** Read a File as base64 (no data-url prefix). */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = r.result as string;
      resolve(s.slice(s.indexOf(",") + 1));
    };
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
