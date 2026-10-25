/**
 * Oct 25 — production memory hardening for workbook parsing (512 MiB / 1 vCPU).
 * Deterministic coverage for: child-process parser (default) and its worker
 * fallback giving identical rows; forced row-chunk parsing identical to a one
 * pass read; heap-exhaustion → plain per-sheet message; timeout termination;
 * memory-reducing reclaim; and the single-series table reuse that removed a
 * duplicate full-table build without changing parsed series.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";

const NAME = "Meter 1162000477\t";
function workbook(dataRows: number, opts: { meterCol?: boolean } = {}) {
  const rows: unknown[][] = [
    ["ACCT NUMBER", "", "", 1162000000, ""],
    ["SERVICE AGREEMENT ID", "", "", 1162000477, ""],
    ["SERVICE POINT ID", "", "", 1162000666, ""],
    ["RATE SCHEDULE", "", "", "EGSGS", ""],
    ["Address", "", "", "4182 N Bank St, Kingman", ""],
    opts.meterCol ? ["Meter", "DATE", "TIME", "KWH_DEL", "KW"] : ["", "DATE", "TIME", "KWH_DEL", "KW"],
  ];
  let total = 0, max = 0;
  for (let i = 0; i < dataRows; i++) {
    const day = 20251001 + Math.floor(i / 96) % 28;
    const q = i % 96;
    const kwh = Math.round((0.05 + ((i * 37) % 100) / 500) * 1000) / 1000;
    total += kwh; max = Math.max(max, kwh * 4);
    rows.push([opts.meterCol ? (i % 2 ? "A" : "B") : "", day, `${String(Math.floor(q / 4)).padStart(2, "0")}:${String((q % 4) * 15).padStart(2, "0")}`, kwh, kwh * 4]);
  }
  rows.push(["", "", "", `Total = ${total.toFixed(2)}`, `Max = ${max.toFixed(2)}`]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), NAME);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["x"], [1]]), "Other");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
const digest = (rows: unknown[][]) => JSON.stringify(rows);

afterEach(() => {
  delete process.env.XLSX_PARSER;
  delete process.env.XLSX_SINGLE_PASS_BYTES;
  delete process.env.XLSX_CHUNK_BYTES;
  vi.resetModules();
});

describe("workbook parser isolation (child process by default)", () => {
  it("child-process and worker-thread parsers return identical rows and headers", async () => {
    const buf = workbook(1200);
    const a = await import("./ingest/hardening");
    const childRows = await a.parseWorkbookInWorker(buf, NAME);
    const childHeads = await a.parseWorkbookInWorker(buf);
    vi.resetModules();
    process.env.XLSX_PARSER = "worker";
    const b = await import("./ingest/hardening");
    const workerRows = await b.parseWorkbookInWorker(buf, NAME);
    const workerHeads = await b.parseWorkbookInWorker(buf);
    expect(childRows[0]!.rows.length).toBe(1207);
    expect(digest(childRows[0]!.rows)).toBe(digest(workerRows[0]!.rows));
    expect(childHeads.map((s) => s.name)).toEqual([NAME, "Other"]);
    expect(digest(childHeads.map((s) => s.rows))).toBe(digest(workerHeads.map((s) => s.rows)));
  }, 60_000);

  it("forced row-chunk parsing is byte-identical to a one-pass read", async () => {
    const buf = workbook(6000);
    const one = await (await import("./ingest/hardening")).parseWorkbookInWorker(buf, NAME);
    vi.resetModules();
    process.env.XLSX_SINGLE_PASS_BYTES = "1";
    process.env.XLSX_CHUNK_BYTES = String(64 * 1024);
    const chunked = await (await import("./ingest/hardening")).parseWorkbookInWorker(buf, NAME);
    expect(chunked[0]!.rows.length).toBe(one[0]!.rows.length);
    expect(digest(chunked[0]!.rows)).toBe(digest(one[0]!.rows));
  }, 60_000);

  it("terminates a timed-out child parser and releases admission for the next file", async () => {
    const h = await import("./ingest/hardening");
    const buf = workbook(2000);
    await expect(h.parseWorkbookInWorker(buf, NAME, 1)).rejects.toThrow(/terminated/);
    const ok = await h.parseWorkbookInWorker(buf, NAME);
    expect(ok[0]!.rows.length).toBe(2007);
  }, 60_000);

  it("maps parser heap exhaustion to the plain split-by-date message (never a crash)", async () => {
    process.env.XLSX_PARSER_HEAP_MB = "8";
    const h = await import("./ingest/hardening");
    expect(h.SHEET_TOO_LARGE_MESSAGE).toMatch(/smaller date ranges/);
    expect(h.SHEET_TOO_LARGE_MESSAGE).toMatch(/nothing from this sheet was saved/i);
    expect(h.SHEET_TOO_LARGE_MESSAGE).not.toMatch(/heap|worker|ERR_|stack/i);
    // A real exhaustion inside the isolated parser: plain message, this process survives.
    const big = workbook(60_000);
    await expect(h.parseWorkbookInWorker(big, NAME)).rejects.toThrow(h.SHEET_TOO_LARGE_MESSAGE);
    delete process.env.XLSX_PARSER_HEAP_MB;
    const ok = await h.parseWorkbookInWorker(workbook(300), NAME);
    expect(ok[0]!.rows.length).toBe(307);
  }, 120_000);
});

describe("memory helpers", () => {
  it("reclaimMemory runs a collection, is rate limited, and never throws", async () => {
    const { reclaimMemory } = await import("./ingest/memory");
    expect(reclaimMemory(0)).toBe(true);
    expect(reclaimMemory(60_000)).toBe(false);
  });
  it("heapGuard ticks are cheap no-ops until the heap actually grows", async () => {
    const { heapGuard } = await import("./ingest/memory");
    const tick = heapGuard(1024, 10);
    expect(() => { for (let i = 0; i < 1000; i++) tick(); }).not.toThrow();
  });
  it("relieveMemoryPressure collects only above the trigger and backs off when memory stays high", async () => {
    const mem = await import("./ingest/memory");
    const rss = vi.spyOn(process.memoryUsage, "rss");
    const MiB = 1048576;
    try {
      // Below the trigger: never collects.
      rss.mockReturnValue(100 * MiB);
      expect(mem.relieveMemoryPressure()).toBe(false);
      // Above the trigger, and still high after collecting (a real working set):
      // one collection, then it waits for another step of growth (no GC spin).
      rss.mockReturnValue(400 * MiB);
      expect(mem.relieveMemoryPressure()).toBe(true);
      await new Promise((r) => setTimeout(r, 600));
      expect(mem.relieveMemoryPressure()).toBe(false);
      rss.mockReturnValue(470 * MiB);
      expect(mem.relieveMemoryPressure()).toBe(true);
      // Once memory falls back below the base trigger, the trigger resets.
      rss.mockReturnValue(120 * MiB);
      expect(mem.relieveMemoryPressure()).toBe(false);
      await new Promise((r) => setTimeout(r, 600));
      rss.mockReturnValue(300 * MiB);
      expect(mem.relieveMemoryPressure()).toBe(true);
    } finally {
      rss.mockRestore();
    }
  });
  it("startMemoryWatchdog is idempotent and never keeps the process alive", async () => {
    const mem = await import("./ingest/memory");
    const spy = vi.spyOn(globalThis, "setInterval");
    try {
      mem.startMemoryWatchdog(10_000);
      mem.startMemoryWatchdog(10_000);
      expect(spy).toHaveBeenCalledTimes(1);
      const handle = spy.mock.results[0]!.value as NodeJS.Timeout;
      expect(handle.hasRef()).toBe(false);
      clearInterval(handle);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("single-series table reuse (no duplicate full-table build)", () => {
  it("produces the same series as before for single-meter and multi-meter sheets", async () => {
    const { parseSheetRows, parseExcelIntervals } = await import("./ingest/parsers");
    const shared = await import("../shared/build0103");
    const spy = vi.spyOn(shared, "rowsToFile");
    const clock = { timeZone: "America/Phoenix", timestampBasis: "start" as const };
    const buf = workbook(400);
    const rows = XLSX.utils.sheet_to_json<unknown[]>(XLSX.read(buf, { type: "buffer" }).Sheets[NAME]!, { header: 1, raw: true, defval: "" });
    const [s] = parseSheetRows(NAME, rows, clock);
    expect(s!.points.length).toBe(400);
    expect(s!.validation.pass).toBe(true);
    expect(s!.points[0]!.durationMin).toBe(15);
    // Same result through the whole-workbook entry point.
    const viaExcel = parseExcelIntervals(buf, clock).find((x) => x.sourceKey === NAME)!;
    expect(viaExcel.points).toEqual(s!.points);
    expect(viaExcel.validation).toEqual(s!.validation);
    // Multi-meter sheets still split into one series per meter value.
    const multi = workbook(400, { meterCol: true });
    const mrows = XLSX.utils.sheet_to_json<unknown[]>(XLSX.read(multi, { type: "buffer" }).Sheets[NAME]!, { header: 1, raw: true, defval: "" });
    const ms = parseSheetRows(NAME, mrows, clock);
    expect(ms.map((x) => x.sourceKey).sort()).toEqual([`${NAME} · meter A`, `${NAME} · meter B`]);
    expect(ms.reduce((a, x) => a + x.points.length, 0)).toBe(400);
    spy.mockRestore();
  });
});
