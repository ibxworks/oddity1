import cors from "cors";
import express from "express";
import { registerProcessGuards } from "../lib/process-guards.js";
import { authMiddleware } from "../lib/auth-middleware.js";
import adaptersRouter from "../routes/adapters.js";
import annotateRouter from "../routes/annotate.js";
import annotationsRouter from "../routes/annotations.js";
import sketchRouter from "../routes/sketch.js";
import feedbackRouter from "../routes/feedback.js";
import userFeedbackRouter from "../routes/user-feedback.js";
import accountRouter from "../routes/user/account.js";
import preferencesRouter from "../routes/user/preferences.js";
import webhookStripeRouter from "../routes/webhook-stripe.js";
import checkoutRouter from "../routes/checkout.js";
import subscriptionRouter from "../routes/subscription.js";
import portalRouter from "../routes/portal.js";
import pricesRouter from "../routes/prices.js";
import convertPdfRouter from "../routes/convert-pdf.js";
import pdfPageSummariesRouter from "../routes/pdf-page-summaries.js";
import personasRouter from "../routes/personas.js";

if (process.env.ODDITY_PROCESS_ROLE !== "worker") {
  registerProcessGuards({ role: "app", exitOnFatal: false });
}

const app = express();

// Global middleware — restrict CORS to known origins
const ALLOWED_ORIGINS = [
  process.env.DASHBOARD_URL,
  "https://app.oddity1.com",
].filter(Boolean) as string[];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow: no origin (Chrome extensions, server-to-server), or matched origin
      if (!origin || ALLOWED_ORIGINS.includes(origin)) {
        callback(null, true);
      } else {
        callback(null, false);
      }
    },
    credentials: true,
  }),
);

// Stripe webhook must receive raw body BEFORE express.json() parses it
app.use("/api/webhook/stripe", express.raw({ type: "application/json" }), webhookStripeRouter);

// PDF conversion needs a higher body limit — mount before the global 2mb parser
app.use("/api/convert-pdf", express.json({ limit: "4.5mb" }), authMiddleware, convertPdfRouter);

app.use(express.json({ limit: "2mb" }));

// Health check (no auth)
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Public routes (no auth)
app.use("/api/adapters", adaptersRouter);
app.use("/api/prices", pricesRouter);
app.use("/api/personas", personasRouter);

// Protected routes
app.use("/api/annotate", authMiddleware, annotateRouter);
app.use("/api/sketch", authMiddleware, sketchRouter);
app.use("/api/annotations/feedback", authMiddleware, feedbackRouter);
app.use("/api/annotations", authMiddleware, annotationsRouter);
app.use("/api/user/account", authMiddleware, accountRouter);
app.use("/api/user/preferences", authMiddleware, preferencesRouter);
app.use("/api/user-feedback", authMiddleware, userFeedbackRouter);
app.use("/api/checkout", authMiddleware, checkoutRouter);
app.use("/api/subscription", authMiddleware, subscriptionRouter);
app.use("/api/portal", authMiddleware, portalRouter);
app.use("/api/pdf-page-summaries", authMiddleware, pdfPageSummariesRouter);

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

export default app;
