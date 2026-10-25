/**
 * Oct 25 — production runs `node dist/index.js` inside a 512 MiB container,
 * but Node 22 sizes the V8 heap from host memory (~3 GiB), so garbage from
 * one workbook sheet (worker rows, parsed series, insert rows) is not
 * collected before the next sheet allocates. Measured on the real KUSD
 * workbook: 8 sheets grew RSS 209→339 MiB (peak 430) without collection and
 * stayed flat at ~200 MiB (peak 307) with a full GC between sheets.
 *
 * reclaimMemory() runs a synchronous full GC between heavy units of work.
 * It is fail-safe: if the runtime refuses to expose gc it becomes a no-op.
 * It is rate-limited so hot loops cannot spend all their time collecting.
 *
 * Oct 25 (later): a plain full GC frees objects, but V8 keeps the emptied
 * 256 KiB heap pages pooled for ~15 s, and that RSS still counts against the
 * container limit (measured: 130 MiB → 130 MiB after gc(), 47 MiB only after
 * the pool timer). The memory-reducing ("last-resort") flavor also releases
 * those pages at once (130 → 48 MiB in ~20 ms), so it is preferred here.
 */
import v8 from "node:v8";
import vm from "node:vm";

type GcFn = (opts?: { type: "major"; execution: "sync"; flavor: "last-resort" }) => void;
let gcFn: GcFn | null | undefined;
let reducing = true;
let lastRun = 0;

function resolveGc(): GcFn | null {
  if (gcFn !== undefined) return gcFn;
  try {
    const existing = (globalThis as { gc?: GcFn }).gc;
    if (typeof existing === "function") return (gcFn = existing);
    v8.setFlagsFromString("--expose_gc");
    const fn = vm.runInNewContext("gc") as unknown;
    gcFn = typeof fn === "function" ? (fn as GcFn) : null;
  } catch {
    gcFn = null;
  }
  return gcFn;
}

/** Full, memory-reducing GC between heavy units (at most once per `minIntervalMs`). */
export function reclaimMemory(minIntervalMs = 250): boolean {
  const now = Date.now();
  if (now - lastRun < minIntervalMs) return false;
  const gc = resolveGc();
  if (!gc) return false;
  lastRun = now;
  if (reducing) {
    try { gc({ type: "major", execution: "sync", flavor: "last-resort" }); return true; }
    catch { reducing = false; }
  }
  try { gc(); return true; } catch { return false; }
}

/** Resident memory in MiB, for progress logs. */
export function rssMiB(): number {
  return Math.round(process.memoryUsage().rss / 1048576);
}

/**
 * Oct 25 (analysis) — one site analysis on a 9-meter campus grew RSS from
 * ~150 to ~420 MiB, nearly all of it collectable garbage (a full GC returned
 * it to ~150 MiB). With the ~3 GiB heap V8 believes it has, one run's garbage
 * was still resident when the next began, and the second analysis of the
 * same campus was OOM-killed in the 512 MiB container.
 *
 * relieveMemoryPressure() is a cheap check (one RSS read) that runs a
 * memory-reducing GC only when resident memory is above a trigger. The
 * trigger adapts: if memory stays high after collecting (a genuinely large
 * working set), the next collection waits for another `PRESSURE_STEP_MIB` of
 * growth, so a legitimately large job never spins in back-to-back GCs.
 */
const PRESSURE_BASE_MIB = Number(process.env.MEMORY_PRESSURE_MIB ?? 288);
const PRESSURE_STEP_MIB = 64;
let pressureTrigger = PRESSURE_BASE_MIB;
export function relieveMemoryPressure(): boolean {
  let rss: number;
  try { rss = process.memoryUsage.rss() / 1048576; } catch { return false; }
  if (rss < PRESSURE_BASE_MIB) { pressureTrigger = PRESSURE_BASE_MIB; return false; }
  if (rss < pressureTrigger) return false;
  if (!reclaimMemory(500)) return false;
  const after = process.memoryUsage.rss() / 1048576;
  pressureTrigger = after < PRESSURE_BASE_MIB ? PRESSURE_BASE_MIB : after + PRESSURE_STEP_MIB;
  return true;
}

let watchdog: ReturnType<typeof setInterval> | null = null;
/**
 * Process-wide safety net: checks memory pressure every `intervalMs` while the
 * event loop turns (between the awaits of any request). Unref'd so it never
 * keeps the process alive; idempotent.
 */
export function startMemoryWatchdog(intervalMs = 500): void {
  if (watchdog) return;
  watchdog = setInterval(() => { relieveMemoryPressure(); }, intervalMs);
  watchdog.unref?.();
}

/**
 * Oct 25 — long synchronous loops (sheet rows → interval series) create
 * short-lived garbage much faster than V8 collects it when it believes it has
 * ~3 GiB. Measured on a 175k-row sheet: heap grew 43 → 245 MiB with only
 * ~120 MiB live; the same loop under a 200 MiB limit stayed at 136 MiB.
 * heapGuard() returns a cheap tick: every `every` calls it reads the heap size
 * and collects only when the heap has grown `growthMiB` since the last
 * collection, so small files never pay for it and large ones stay bounded.
 */
export function heapGuard(growthMiB = 48, every = 4096): () => void {
  let n = 0;
  let base = v8.getHeapStatistics().used_heap_size;
  const limit = growthMiB * 1048576;
  return () => {
    if (++n % every) return;
    const used = v8.getHeapStatistics().used_heap_size;
    if (used - base < limit) return;
    const gc = resolveGc();
    if (!gc) return;
    try { gc(); } catch { return; }
    base = v8.getHeapStatistics().used_heap_size;
  };
}
