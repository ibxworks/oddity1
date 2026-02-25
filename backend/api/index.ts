import cors from "cors";
import express from "express";
import { authMiddleware } from "../lib/auth-middleware.js";
import { createRateLimiter } from "../lib/rate-limiter.js";
import adaptersRouter from "./adapters.js";
import annotateRouter from "./annotate.js";
import annotationsRouter from "./annotations.js";
import preferencesRouter from "./user/preferences.js";

const app = express();

// Global middleware
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Health check (no auth)
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Public routes (no auth)
app.use("/api/adapters", adaptersRouter);

// Protected routes
app.use("/api/annotate", authMiddleware, createRateLimiter(), annotateRouter);
app.use("/api/annotations", authMiddleware, annotationsRouter);
app.use("/api/user/preferences", authMiddleware, preferencesRouter);

// Global error handler
app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error("[Oddity 1] Unhandled error:", err);
    res.status(500).json({ error: "Internal server error" });
  },
);

// For local development
if (process.env.NODE_ENV !== "production") {
  const port = process.env.PORT ?? 3001;
  app.listen(port, () => {
    console.log(`[Oddity 1] Backend listening on :${port}`);
  });
}

export default app;
