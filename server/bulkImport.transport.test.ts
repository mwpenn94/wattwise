import { describe, expect, it } from "vitest";

// Exercise the running app's actual Express middleware, not createCaller() or a
// copied middleware fixture. All requests are unauthenticated, so accepted JSON
// stops at authentication and can never stage a source or mutate any tenant.
const base = "http://localhost:3000/api/trpc";
const post = (route: string, body: string) => fetch(`${base}/${route}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body,
  signal: AbortSignal.timeout(30_000),
});

describe("bulk upload HTTP transport boundaries", () => {
  it("admits a 50 MiB file's base64 JSON through the dedicated body parser", async () => {
    const decodedBytes = 50 * 1024 * 1024;
    const contentBase64 = "A".repeat(Math.ceil(decodedBytes / 3) * 4);
    const response = await post("bulkImport.stageFile", JSON.stringify({ json: { filename: "boundary.xlsx", contentBase64 } }));
    expect(response.status).toBe(401);
    expect(await response.text()).toContain("UNAUTHORIZED");
  }, 45_000);

  it("retains the generic 50 MiB body cap on other RPC routes", async () => {
    const response = await post("auth.me", JSON.stringify({ padding: "A".repeat(50 * 1024 * 1024) }));
    expect(response.status).toBe(413);
  }, 45_000);

  it("rejects bodies above the dedicated 68 MiB cap", async () => {
    const response = await post("bulkImport.stageFile", JSON.stringify({ padding: "A".repeat(68 * 1024 * 1024) }));
    expect(response.status).toBe(413);
  }, 45_000);

  it("rejects batched and mixed bulk upload paths before admission", async () => {
    for (const route of ["bulkImport.stageFile?batch=1", "bulkImport.stageFile,auth.me?batch=1"]) {
      const response = await post(route, "{}");
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("dedicated non-batched transport");
    }
  });
});
