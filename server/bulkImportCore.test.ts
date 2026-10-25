import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSitePlan,
  cleanSheetName,
  extractSheetHeaderMeta,
  meterIdentityKey,
  parseServiceAddress,
  prettyCase,
  readWorkbookHeaders,
  type PlanSheetInput,
} from "./bulkImportCore";

const firstHalf = "/home/ubuntu/upload/1026KUSD-IntervalDataRequestPLL10202026firsthalf(3).xlsx";
const secondHalf = "/home/ubuntu/upload/1026KUSD-IntervalDataRequestPLL10202026secondhalf.xlsx";

describe("bulk import core", () => {
  it("parses utility service addresses without turning facilities into sites", () => {
    expect(parseServiceAddress("4182 N Bank St, Unit C, Kingman")).toMatchObject({
      street: "4182 N Bank St",
      descriptors: ["Unit C"],
      city: "Kingman",
      state: null,
      zip: null,
      hasStreetNumber: true,
    });
    expect(parseServiceAddress("16500 N Pierce Ferry Rd, 1, Dolan Springs")).toMatchObject({
      street: "16500 N Pierce Ferry Rd",
      descriptors: ["1"],
      city: "Dolan Springs",
      hasStreetNumber: true,
    });
    expect(parseServiceAddress("500 Maple St, Kingman, AZ 86401")).toMatchObject({
      street: "500 Maple St",
      descriptors: [],
      city: "Kingman",
      state: "AZ",
      zip: "86401",
      hasStreetNumber: true,
    });
    expect(parseServiceAddress("Jr High Tennis, Kingman ")).toMatchObject({
      street: "Jr High Tennis",
      city: "Kingman",
      hasStreetNumber: false,
    });

    expect(parseServiceAddress("3700 PROSPECTOR ST, KINGMAN").campusKey).toBe(
      parseServiceAddress("3700 Prospector St, Kingman").campusKey,
    );
  });

  it("extracts header metadata from the UNS-style top-of-sheet block", () => {
    const rows: unknown[][] = [
      ["ACCT NUMBER", "", "", "1162000477"],
      ["SERVICE AGREEMENT ID", "", "", "SA-100"],
      ["SERVICE POINT ID", "", "", "SP-100"],
      ["RATE SCHEDULE", "", "", "EGSGS"],
      ["Address", "", "", "4182 N Bank St, Unit C, Kingman"],
      ["", "DATE", "TIME", "KWH_DEL", "KW"],
    ];

    expect(extractSheetHeaderMeta("1162000477_x0009_", rows)).toEqual({
      sheetName: "1162000477_x0009_",
      accountNumber: "1162000477",
      serviceAgreementId: "SA-100",
      servicePointId: "SP-100",
      rateScheduleCode: "EGSGS",
      addressRaw: "4182 N Bank St, Unit C, Kingman",
      looksLikeIntervals: true,
    });
    expect(cleanSheetName("1162000477_x0009_")).toBe("1162000477");
    expect(prettyCase("3700 PROSPECTOR ST")).toBe("3700 Prospector St");
    expect(prettyCase("3700 Prospector St")).toBe("3700 Prospector St");
    expect(meterIdentityKey({ servicePointId: "SP-100", serviceAgreementId: "SA-100", sheetName: "ignored" })).toBe("sp:SP-100");
    expect(meterIdentityKey({ servicePointId: null, serviceAgreementId: "SA-100", sheetName: "ignored" })).toBe("sa:SA-100");
    expect(()=>meterIdentityKey({ servicePointId: null, serviceAgreementId: null, sheetName: "1162000477_x0009_" })).toThrow(/durable/);
  });

  it("groups across files by campus, keeps buildings distinct, honors overrides, and flags uncertain duplicates", () => {
    const sheets: PlanSheetInput[] = [
      { sheetId: 1, fileId: 1, sheetName: "Unit A", addressRaw: "100 Test Ave, Unit A, Kingman", servicePointId: "SP-A", serviceAgreementId: "SA-A", rateScheduleCode: "EGSGS" },
      { sheetId: 2, fileId: 2, sheetName: "Unit B", addressRaw: "100 Test Avenue, Unit B, Kingman", servicePointId: "SP-B", serviceAgreementId: "SA-B", rateScheduleCode: "EGMGS" },
      { sheetId: 3, fileId: 2, sheetName: "Unit A duplicate", addressRaw: "100 TEST AVE, Unit A, KINGMAN", servicePointId: "SP-B", serviceAgreementId: "SA-B-copy", rateScheduleCode: "EGMGS" },
      { sheetId: 4, fileId: 1, sheetName: "Other", addressRaw: "200 Other Rd, Kingman", servicePointId: "SP-C", serviceAgreementId: "SA-C", rateScheduleCode: "EGMGSQ" },
      { sheetId: 5, fileId: 1, sheetName: "Tennis 1", addressRaw: "Jr High Tennis, Kingman", servicePointId: "SP-T1", serviceAgreementId: "SA-T1", rateScheduleCode: null },
      { sheetId: 6, fileId: 2, sheetName: "Tennis 2", addressRaw: "Jr High Tennis, Kingman", servicePointId: "SP-T2", serviceAgreementId: "SA-T2", rateScheduleCode: null },
      { sheetId: 7, fileId: 1, sheetName: "Forced", addressRaw: "300 Override Rd, Kingman", servicePointId: "SP-O", serviceAgreementId: "SA-O", rateScheduleCode: null, overrideSiteId: 77 },
    ];

    const campus = buildSitePlan(sheets, "campus");
    const campusTest = campus.find((group) => group.street === "100 Test Ave");
    expect(campus).toHaveLength(5);
    expect(campusTest).toMatchObject({ sheetIds: [1, 2, 3], fileIds: [1, 2] });
    expect(campusTest?.facilities).toMatchObject({ 1: "Unit A", 2: "Unit B", 3: "Unit A" });
    expect(campusTest?.needsReview).toContain("Service point SP-B appears in more than one sheet — copies merge only when their destination agrees; conflicting destinations are rejected.");
    expect(campus.filter((group) => group.needsReview.some((note) => note.includes("no street number")))).toHaveLength(2);
    expect(campus.find((group) => group.groupKey === "site:77")).toMatchObject({ existingSiteId: 77, sheetIds: [7] });

    const building = buildSitePlan(sheets, "building");
    expect(building).toHaveLength(6);
    expect(building.find((group) => group.groupKey === "100 test ave|kingman|?|US|unit a")?.sheetIds).toEqual([1, 3]);
    expect(building.find((group) => group.groupKey === "100 test ave|kingman|?|US|unit b")?.sheetIds).toEqual([2]);
  });
});

describe.skipIf(!fs.existsSync(firstHalf) || !fs.existsSync(secondHalf))("bulk import core real workbooks", () => {
  it("reads all supplied worksheet headers and preserves expected campus/building grouping", () => {
    const sheets = [
      ...readWorkbookHeaders(fs.readFileSync(firstHalf)).map((sheet, index) => ({ ...sheet, fileId: 1, sheetId: index + 1 })),
      ...readWorkbookHeaders(fs.readFileSync(secondHalf)).map((sheet, index) => ({ ...sheet, fileId: 2, sheetId: index + 101 })),
    ];
    const campus = buildSitePlan(sheets, "campus");
    const bank = campus.find((group) => group.street?.toLowerCase() === "4182 n bank st");

    expect(sheets).toHaveLength(38);
    expect(campus).toHaveLength(18);
    expect(buildSitePlan(sheets, "building")).toHaveLength(37);
    expect(bank).toMatchObject({ sheetIds: expect.any(Array), fileIds: [1, 2] });
    expect(bank?.sheetIds).toHaveLength(8);
  });
});

it("does not merge the same street/city across states",()=>{const base={sheetId:1,fileId:1,sheetName:"a",servicePointId:"a",serviceAgreementId:"sa",rateScheduleCode:null};expect(buildSitePlan([{...base,addressRaw:"100 Main St, Springfield, IL"},{...base,sheetId:2,servicePointId:"b",addressRaw:"100 Main St, Springfield, MA"}],"campus")).toHaveLength(2);});
