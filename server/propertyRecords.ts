export type PropertyRecordLink = {
  label: string;
  url: string;
  kind: "official" | "directory";
  note: string;
};

export type PropertyRecordsResult = {
  county: string | null;
  state: string | null;
  links: PropertyRecordLink[];
};

export function countySlug(county: string): string {
  return county
    .replace(/\bcounty\b/gi, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizedState(state: string | null | undefined): string | null {
  const value = state?.trim().toUpperCase() ?? "";
  return /^[A-Z]{2}$/.test(value) ? value : null;
}

const OFFICIAL_LINKS: Record<string, PropertyRecordLink[]> = {
  "AZ:mohave": [
    {
      label: "Mohave County Assessor parcel search",
      url: "https://appsweb.mohave.gov/data_apps/assessor_parcel_search",
      kind: "official",
      note: "Official Mohave County assessor search.",
    },
    {
      label: "Mohave County Assessor",
      url: "https://www.mohave.gov/departments/assessor/",
      kind: "official",
      note: "Official assessor information and services.",
    },
    {
      label: "Mohave County Recorder search",
      url: "https://eaglerss.mohave.gov/web/",
      kind: "official",
      note: "Official Mohave County recorder search.",
    },
    {
      label: "Mohave County GIS open data",
      url: "https://az-mohave.opendata.arcgis.com/",
      kind: "official",
      note: "Official county GIS open-data portal.",
    },
  ],
};

export function officialPropertyRecordLinks(county: string | null | undefined, state: string | null | undefined): PropertyRecordLink[] {
  const stateCode = normalizedState(state);
  const slug = county ? countySlug(county) : "";
  return stateCode && slug ? (OFFICIAL_LINKS[`${stateCode}:${slug}`] ?? []).map((link) => ({ ...link })) : [];
}

export function propertyRecordsForCounty(county: string | null | undefined, state: string | null | undefined): PropertyRecordsResult {
  const stateCode = normalizedState(state);
  const slug = county ? countySlug(county) : "";
  const normalizedCounty = slug ? county!.replace(/\s+county\s*$/i, "").trim() : null;
  const links = officialPropertyRecordLinks(normalizedCounty, stateCode);
  if (stateCode && slug) {
    links.push({
      label: "CountyOffice property records directory",
      url: `https://www.countyoffice.org/${stateCode.toLowerCase()}-${slug}-county-property-records/`,
      kind: "directory",
      note: "Third-party directory; opens on CountyOffice at your request.",
    });
  }
  return { county: normalizedCounty, state: stateCode, links };
}
