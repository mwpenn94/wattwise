import { describe, expect, it } from "vitest";
import { countySlug, officialPropertyRecordLinks, propertyRecordsForCounty } from "./propertyRecords";

describe("property-record link registry", () => {
  it("builds stable county slugs", () => {
    expect(countySlug("Mohave County")).toBe("mohave");
    expect(countySlug("St. Louis County")).toBe("st-louis");
  });

  it("returns Mohave County's official registry links", () => {
    const links = officialPropertyRecordLinks("Mohave County", "az");
    expect(links).toHaveLength(4);
    expect(links.map((link) => link.kind)).toEqual(["official", "official", "official", "official"]);
    expect(links[0].url).toBe("https://appsweb.mohave.gov/data_apps/assessor_parcel_search");
  });

  it("keeps repeated county responses and the official registry independent", () => {
    const first = propertyRecordsForCounty("Mohave County", "AZ");
    const second = propertyRecordsForCounty("Mohave County", "AZ");
    expect(first.links).toHaveLength(5);
    expect(second.links).toHaveLength(5);
    expect(new Set(second.links.map((link) => link.url)).size).toBe(5);
    expect(officialPropertyRecordLinks("Mohave", "AZ")).toHaveLength(4);
    first.links[0].label = "changed by a consumer";
    expect(second.links[0].label).toBe("Mohave County Assessor parcel search");
    expect(officialPropertyRecordLinks("Mohave", "AZ")[0].label).toBe("Mohave County Assessor parcel search");
  });

  it("falls back to an outbound CountyOffice directory link for any U.S. county", () => {
    const result = propertyRecordsForCounty("Coconino County", "AZ");
    expect(result.county).toBe("Coconino");
    expect(result.state).toBe("AZ");
    expect(result.links).toEqual([
      {
        label: "CountyOffice property records directory",
        url: "https://www.countyoffice.org/az-coconino-county-property-records/",
        kind: "directory",
        note: "Third-party directory; opens on CountyOffice at your request.",
      },
    ]);
  });
});
