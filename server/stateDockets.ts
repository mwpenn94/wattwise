/**
 * DKT-1/DKT-2 (owner directive Jul 22): territory-driven commission docket
 * watches — systemic, nationwide, zero prompting.
 *
 * Every state where the user has at least one site gets an auto-registered
 * docket-watch source pointing at that state's public utility commission
 * docket/filings index. The weekly fingerprint sweep detects page movement
 * (new filings churn the index) and the monthly agent reads the page for
 * rate-case specifics. Docket sources govern no tariff rows — they exist for
 * advance notice only and can never mutate rates.
 *
 * The URL registry below covers all 50 states + DC with each commission's
 * official docket search / e-filing index page. Where a commission's search
 * is POST-only or session-gated (fingerprinting would be meaningless), we
 * point at the commission's main filings/news page instead — still official,
 * still churns when rate cases move. The agent handles the deep lookup.
 *
 * ensureDocketCoverage() is called from the weekly sweep: it diffs the states
 * that have sites against registered docket sources and registers any missing
 * ones. Adding a site in a new state therefore auto-creates the docket watch
 * within a week — same demand-driven pattern as rate acquisition.
 */
import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { rateSources, sites } from "../drizzle/schema";

/** Official commission docket/filings index pages, all 50 states + DC. */
export const STATE_COMMISSION_DOCKETS: Record<string, { commission: string; url: string }> = {
  AL: { commission: "Alabama Public Service Commission", url: "https://www.psc.alabama.gov/" },
  AK: { commission: "Regulatory Commission of Alaska", url: "https://rca.alaska.gov/RCAWeb/Dockets/RecentlyFiledDockets.aspx" },
  AZ: { commission: "Arizona Corporation Commission", url: "https://edocket.azcc.gov/" },
  AR: { commission: "Arkansas Public Service Commission", url: "http://www.apscservices.info/efilings/docket_search.asp" },
  CA: { commission: "California Public Utilities Commission", url: "https://apps.cpuc.ca.gov/apex/f?p=401:1:0" },
  CO: { commission: "Colorado Public Utilities Commission", url: "https://puc.colorado.gov/puc-e-filings-system" },
  CT: { commission: "Connecticut PURA", url: "https://portal.ct.gov/pura" },
  DE: { commission: "Delaware Public Service Commission", url: "https://depsc.delaware.gov/" },
  DC: { commission: "DC Public Service Commission", url: "https://edocket.dcpsc.org/public/search" },
  FL: { commission: "Florida Public Service Commission", url: "https://www.floridapsc.com/ClerkOffice/DocketList" },
  GA: { commission: "Georgia Public Service Commission", url: "https://psc.ga.gov/search/facts-advanced-search/" },
  HI: { commission: "Hawaii Public Utilities Commission", url: "https://puc.hawaii.gov/dockets/" },
  ID: { commission: "Idaho Public Utilities Commission", url: "https://puc.idaho.gov/case" },
  IL: { commission: "Illinois Commerce Commission", url: "https://www.icc.illinois.gov/docket" },
  IN: { commission: "Indiana Utility Regulatory Commission", url: "https://iurc.portal.in.gov/docketed-case-search/" },
  IA: { commission: "Iowa Utilities Commission", url: "https://iuc.iowa.gov/open-dockets" },
  KS: { commission: "Kansas Corporation Commission", url: "https://estar.kcc.ks.gov/estar/portal/kcc/page/docket-search/portal.aspx" },
  KY: { commission: "Kentucky Public Service Commission", url: "https://psc.ky.gov/Case/Search" },
  LA: { commission: "Louisiana Public Service Commission", url: "https://www.lpsc.louisiana.gov/Dockets" },
  ME: { commission: "Maine Public Utilities Commission", url: "https://mpuc-cms.maine.gov/CQM.Public.WebUI/Common/CaseList.aspx" },
  MD: { commission: "Maryland Public Service Commission", url: "https://www.psc.state.md.us/search-results/" },
  MA: { commission: "Massachusetts DPU", url: "https://eeaonline.eea.state.ma.us/DPU/Fileroom/dockets/bynumber" },
  MI: { commission: "Michigan Public Service Commission", url: "https://mi-psc.my.site.com/s/global-search/%40uri" },
  MN: { commission: "Minnesota Public Utilities Commission", url: "https://www.edockets.state.mn.us/edockets/searchDocuments.do?method=showeDocketsSearch" },
  MS: { commission: "Mississippi Public Service Commission", url: "https://www.psc.ms.gov/" },
  MO: { commission: "Missouri Public Service Commission", url: "https://efis.psc.mo.gov/Case/CaseSearch" },
  MT: { commission: "Montana Public Service Commission", url: "https://psc.mt.gov/Regulated-Utilities/REDDI" },
  NE: { commission: "Nebraska Public Service Commission", url: "https://psc.nebraska.gov/natural-gas/natural-gas-dockets" },
  NV: { commission: "Public Utilities Commission of Nevada", url: "https://pucn.nv.gov/Dockets/Dockets/" },
  NH: { commission: "New Hampshire Public Utilities Commission", url: "https://puc.nh.gov/Regulatory/quickfinder.html" },
  NJ: { commission: "New Jersey Board of Public Utilities", url: "https://publicaccess.bpu.state.nj.us/" },
  NM: { commission: "New Mexico Public Regulation Commission", url: "https://edocket.prc.nm.gov/" },
  NY: { commission: "New York Public Service Commission", url: "https://documents.dps.ny.gov/public/Common/SearchResults.aspx?MC=1" },
  NC: { commission: "North Carolina Utilities Commission", url: "https://starw1.ncuc.gov/NCUC/page/Dockets/portal.aspx" },
  ND: { commission: "North Dakota Public Service Commission", url: "https://www.psc.nd.gov/database/cases.php" },
  OH: { commission: "Public Utilities Commission of Ohio", url: "https://dis.puc.state.oh.us/" },
  OK: { commission: "Oklahoma Corporation Commission", url: "https://oklahoma.gov/occ/divisions/judicial/case-processing.html" },
  OR: { commission: "Oregon Public Utility Commission", url: "https://apps.puc.state.or.us/edockets/DocketNoticeOfRecentFilings.asp" },
  PA: { commission: "Pennsylvania Public Utility Commission", url: "https://www.puc.pa.gov/filing-resources/search-pa-puc-documents/" },
  RI: { commission: "Rhode Island PUC", url: "https://ripuc.ri.gov/DocketsElectronicallyFiled" },
  SC: { commission: "Public Service Commission of South Carolina", url: "https://dms.psc.sc.gov/" },
  SD: { commission: "South Dakota Public Utilities Commission", url: "https://puc.sd.gov/Dockets/" },
  TN: { commission: "Tennessee Public Utility Commission", url: "https://www.tn.gov/tpuc/tpuc-dockets.html" },
  TX: { commission: "Public Utility Commission of Texas", url: "https://interchange.puc.texas.gov/search/filings/" },
  UT: { commission: "Utah Public Service Commission", url: "https://psc.utah.gov/current-dockets/" },
  VT: { commission: "Vermont Public Utility Commission", url: "https://epuc.vermont.gov/?q=case-search" },
  VA: { commission: "Virginia State Corporation Commission", url: "https://scc.virginia.gov/pages/Case-Information" },
  WA: { commission: "Washington UTC", url: "https://www.utc.wa.gov/casedocket" },
  WV: { commission: "West Virginia Public Service Commission", url: "http://www.psc.state.wv.us/webdocket/default.htm" },
  WI: { commission: "Public Service Commission of Wisconsin", url: "https://apps.psc.wi.gov/ERF/ERF/ERFhome.aspx" },
  WY: { commission: "Wyoming Public Service Commission", url: "https://dms.wyo.gov/external/publicusers.aspx" },
};

/** Territory-driven docket auto-registration: for every state with at least
 * one site, ensure a docket-watch source exists. Idempotent; called from the
 * weekly sweep so a site added in a new state gets its watch within a week. */
export async function ensureDocketCoverage(): Promise<{ registered: string[]; alreadyCovered: number; unknownStates: string[] }> {
  const db = await getDb();
  if (!db) throw new Error("db unavailable");
  // states with sites (uppercase 2-letter)
  const siteRows = await db.select({ state: sites.state }).from(sites);
  const siteStates = Array.from(
    new Set(
      siteRows
        .map((r) => (r.state ?? "").trim().toUpperCase())
        .filter((s) => s.length === 2),
    ),
  );
  const registered: string[] = [];
  const unknownStates: string[] = [];
  let alreadyCovered = 0;
  for (const st of siteStates) {
    const entry = STATE_COMMISSION_DOCKETS[st];
    if (!entry) {
      unknownStates.push(st);
      continue;
    }
    const sourceKey = `docket-state-${st.toLowerCase()}`;
    const existing = await db.select({ id: rateSources.id }).from(rateSources).where(eq(rateSources.sourceKey, sourceKey)).limit(1);
    if (existing.length > 0) {
      alreadyCovered++;
      continue;
    }
    await db.insert(rateSources).values({
      sourceKey,
      utilityName: entry.commission,
      commodity: "electric", // commission-wide watch; commodity is nominal
      state: st,
      sourceUrl: entry.url,
      sourceLabel: `${entry.commission} docket index (auto-registered — sites in ${st})`,
      governsUrdbIds: [],
      adjustorCycle: "none",
      verifyCadenceDays: 45,
      sourceKind: "docket",
    });
    registered.push(st);
  }
  return { registered, alreadyCovered, unknownStates };
}
