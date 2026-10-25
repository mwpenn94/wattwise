import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { parseIntervalInstant, parseSheetRows } from "./ingest/parsers";
import { parseWorkbookInWorker, preflightWorkbookZip, preParseGate } from "./ingest/hardening";
const clock={timeZone:"America/Phoenix",timestampBasis:"start" as const,ambiguousTime:"reject" as const};
const rows=(date:number,times:string[])=>[["DATE","TIME","KWH_DEL","KW"],...times.map(t=>[date,t,1,4])];
describe("source clocks",()=>{
  it.each(["UTC","America/New_York","Asia/Tokyo"])("Phoenix is independent of host TZ=%s",host=>{
    const old=process.env.TZ;
    try {process.env.TZ=host;const [s]=parseSheetRows("AZ",rows(20261020,["00:00","00:15","00:30"]),clock);
      expect(s.points.map(p=>new Date(p.ts).toISOString())).toEqual(["2026-10-20T07:00:00.000Z","2026-10-20T07:15:00.000Z","2026-10-20T07:30:00.000Z"]);
      expect(s.points.every(p=>p.durationMin===15)).toBe(true);
    }finally {if(old==null)delete process.env.TZ;else process.env.TZ=old;}
  });
  it.each([[20260308,["01:45","02:00","02:15"]],[20261101,["01:00","01:15","01:30"]]] as const)("rejects unresolved DST %s",(date,times)=>{
    expect(()=>parseSheetRows("DST",rows(date,[...times]),{...clock,timeZone:"America/New_York"})).toThrow(/ambiguous|nonexistent/i);
  });
  it("preserves both explicit-offset fold instants",()=>{
    const [s]=parseSheetRows("offsets",[["Timestamp","kWh"],["2026-11-01T01:15:00-04:00",1],["2026-11-01T01:15:00-05:00",1],["2026-11-01T01:30:00-05:00",1]],{...clock,timeZone:"America/New_York"});
    expect(s.points.map(p=>new Date(p.ts).toISOString())).toEqual(["2026-11-01T05:15:00.000Z","2026-11-01T06:15:00.000Z","2026-11-01T06:30:00.000Z"]);
  });
  it("handles Excel serials, fractional time, midnight rollover and seconds",()=>{
    expect(parseIntervalInstant(45950,0.5,clock)).toBe(Date.parse("2025-10-20T19:00:00Z"));
    expect(parseIntervalInstant(20261020,"24:00",clock)).toBe(Date.parse("2026-10-21T07:00:00Z"));
    expect(parseIntervalInstant(20261020,"00:15:30",clock)).toBe(Date.parse("2026-10-20T07:15:30Z"));
    expect(parseIntervalInstant("03/08/2026 3:00:00 AM",null,{...clock,timeZone:"America/New_York"})).toBe(Date.parse("2026-03-08T07:00:00Z"));
    expect(()=>parseIntervalInstant(20261020,"25:00",clock)).toThrow(/Invalid/);
    expect(()=>parseIntervalInstant(20261020,"not-time",clock)).toThrow(/Malformed/);
  });
  it("converts confirmed interval ends to UTC starts across the year boundary",()=>{
    const [s]=parseSheetRows("end",rows(20251001,["00:15","00:30","00:45"]),{...clock,timestampBasis:"end"});
    expect(s.points[0].ts).toBe(Date.parse("2025-10-01T07:00:00Z"));
    expect(parseIntervalInstant(20260706,"15:00",clock)).toBe(Date.parse("2026-07-06T22:00:00Z"));
  });
  it("discloses missing footer evidence instead of claiming a matched total",()=>{
    const [s]=parseSheetRows("no-footer",rows(20261020,["00:00","00:15","00:30"]),clock);
    expect(s.validation.footerUsageDelta).toBeUndefined();
    expect(s.validation.notes).toContain("No workbook Total= footer available; usage sum has not been independently reconciled.");
    expect(s.validation.notes.some(n=>n.includes("matches workbook Total="))).toBe(false);
  });
});
describe("bounded XLSX parsing",()=>{
  const make=()=>{const w=XLSX.utils.book_new();XLSX.utils.book_append_sheet(w,XLSX.utils.aoa_to_sheet(rows(20261020,["00:00","00:15","00:30"])),"safe");return XLSX.write(w,{type:"buffer",bookType:"xlsx"}) as Buffer;};
  it("reads valid workbooks outside the Express thread",async()=>{const b=make();expect(preflightWorkbookZip(b).sheets).toBe(1);expect((await parseWorkbookInWorker(b))[0].name).toBe("safe");});
  it("rejects expanded-byte bombs before inflation",()=>{const b=make();const c=b.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));b.writeUInt32LE(300*1024*1024,c+24);expect(()=>preflightWorkbookZip(b)).toThrow(/expands/);});
  it("terminates a timed-out parser and releases admission",async()=>{await expect(parseWorkbookInWorker(make(),undefined,1)).rejects.toThrow(/terminated/);expect((await parseWorkbookInWorker(make())).length).toBe(1);});
  it("rejects the decoded size boundary before parsing",()=>{expect(preParseGate(Buffer.alloc(50*1024*1024+1),"xlsx").ok).toBe(false);});
});
