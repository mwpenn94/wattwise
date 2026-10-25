import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ sources: [] as any[], updates: [] as any[], audits: [] as any[], source: null as any }));
vi.mock("./db", () => ({ getDb: async () => ({
  select: () => ({ from: () => {
    const all: any = { where: () => ({ limit: async () => [state.source] }), then: (resolve: any, reject: any) => Promise.resolve(state.sources).then(resolve, reject) };
    return all;
  } }),
  update: (table: any) => ({ set: (value: any) => { state.updates.push(value); return { where: async () => undefined }; } }),
  insert: () => ({ values: async (v: any) => { state.audits.push(v); } }),
}) }));
import { applyAgentFinding } from "./rateCurrency";
beforeEach(() => {
  state.updates=[]; state.audits=[]; state.sources=[];
  state.source={ id: 1, sourceKey:"unse-az-ppfac", governsUrdbIds:["uns-egmgs"], sourceLabel:"PPFAC" };
});
describe("UNS multi-document watcher safety", () => {
  it("flags changed rider documents without silently applying legacy flat-energy updates", async () => {
    const r=await applyAgentFinding({sourceKey:"unse-az-ppfac",status:"changed",evidence:"sheet 701-1 new monthly version",observed:[{urdbId:"uns-egmgs",energyRates:[{label:"All energy",ratePerUnit:.075}]}]},1000);
    expect(r.action).toBe("flagged_for_review");
    expect(state.updates.some((u)=>u.structure)).toBe(false);
    expect(state.updates).toContainEqual({verifyStatus:"change_detected"});
    expect(state.audits[0].applied).toBe(false);
  });
  it("does not mark commercial tariffs current while another governing document has an unresolved change", async () => {
    state.sources=[{sourceKey:"unse-az-ppfac",lastVerifiedAt:1000,changeDetectedAt:null,adjustorCycle:"none",verifyCadenceDays:30},{sourceKey:"unse-az-riders",lastVerifiedAt:1000,changeDetectedAt:900,adjustorCycle:"none",verifyCadenceDays:30}];
    await applyAgentFinding({sourceKey:"unse-az-ppfac",status:"confirmed",evidence:"sheet 701-1 unchanged"},1000);
    expect(state.updates).toContainEqual({verifyStatus:"change_detected"});
    expect(state.updates.some((u)=>u.verifyStatus==="current")).toBe(false);
  });
});
