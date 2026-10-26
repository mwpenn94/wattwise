import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { registerStorageProxy } from "./storageProxy";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { digestHandler, refreshReferenceHandler } from "../scheduledHandlers";
import { rateVerifyHandler } from "../rateVerifyHandler";
import { stripeWebhookHandler } from "../stripeBilling";
import { rawUploadCompleteHandler, rawUploadHandler, rawUploadPartHandler, rawUploadStartHandler } from "../rawUpload";
import { startMemoryWatchdog } from "../ingest/memory";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  // Oct 25: production runs in a 512 MiB container while V8 sizes its heap
  // from host memory (~3 GiB), so collectable garbage from large analyses
  // and imports can pile up until the container is killed. The watchdog
  // collects only when resident memory is genuinely high (see ingest/memory).
  if (process.env.NODE_ENV !== "development") startMemoryWatchdog();
  const app = express();
  const server = createServer(app);
  // Stripe signatures cover the exact raw bytes; this route must precede the
  // global JSON parser and stays setup-blocked until test-mode secrets exist.
  app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), stripeWebhookHandler);
  // Oct 25: interval workbooks arrive as raw bytes streamed to storage (see
  // server/rawUpload.ts); mounted before any body parser so nothing buffers them.
  app.post("/api/uploads/raw", rawUploadHandler);
  // Oct 26: resumable part uploads for slow connections (same signed reference at the end).
  app.post("/api/uploads/raw/start", express.json({ limit: "16kb" }), rawUploadStartHandler);
  app.post("/api/uploads/raw/part", rawUploadPartHandler);
  app.post("/api/uploads/raw/complete", express.json({ limit: "64kb" }), rawUploadCompleteHandler);
  // Configure body parser with larger size limit for file uploads
  app.use("/api/trpc", (req, res, next) => {
    if (req.path.includes("bulkImport.stageFile") && (req.path !== "/bulkImport.stageFile" || req.query.batch != null)) {
      res.status(400).json({ error: "Bulk uploads require the dedicated non-batched transport." });
      return;
    }
    next();
  });
  // 50 MiB decoded requires 66.67 MiB base64 plus JSON overhead.
  app.use("/api/trpc/bulkImport.stageFile", express.json({ limit: "68mb" }));
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  registerStorageProxy(app);
  registerOAuthRoutes(app);
  // Heartbeat cron callbacks — must be mounted before the Vite/static fallthrough
  app.post("/api/scheduled/digest", digestHandler);
  app.post("/api/scheduled/refreshReference", refreshReferenceHandler);
  // CURR-5 rate-currency engine: GET = verification targets for the monthly
  // AGENT cron; POST = agent findings applied conservatively.
  app.get("/api/scheduled/rateVerify", rateVerifyHandler);
  app.post("/api/scheduled/rateVerify", rateVerifyHandler);
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}

startServer().catch(console.error);
