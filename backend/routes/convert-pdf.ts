import type { UserTier } from "@oddity/shared";
import { canUseFeature } from "@oddity/shared";
import { Router } from "express";

const FC_BASE = "https://api.freeconvert.com/v1";
const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 55_000; // Leave margin within Vercel's 60s limit
const MAX_PDF_SIZE = 3 * 1024 * 1024; // 3MB raw PDF

const router = Router();

// ─── FreeConvert API helper ───

async function fcFetch<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const apiKey = process.env.FREECONVERT_API_KEY!;
  const res = await fetch(`${FC_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`FreeConvert ${method} ${path} failed (${res.status}): ${text}`);
  }

  return res.json() as Promise<T>;
}

// ─── Route ───

router.post("/", async (req, res) => {
  const apiKey = process.env.FREECONVERT_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "PDF conversion is not configured" });
    return;
  }

  // ── Tier gate ──
  const userTier = (req.user?.tier ?? "free") as UserTier;
  if (!canUseFeature(userTier, "pdfAnnotation")) {
    res.status(403).json({
      error: "PDF conversion requires a Standard plan",
      upgrade: true,
    });
    return;
  }

  // ── Validate payload ──
  const { pdfBase64 } = req.body as { pdfBase64?: string };
  if (!pdfBase64 || typeof pdfBase64 !== "string") {
    res.status(400).json({ error: "Missing pdfBase64 in request body" });
    return;
  }

  const pdfBuffer = Buffer.from(pdfBase64, "base64");
  if (pdfBuffer.length > MAX_PDF_SIZE) {
    res.status(413).json({
      error: `PDF too large (${Math.round(pdfBuffer.length / 1024 / 1024)}MB). Maximum is 3MB.`,
    });
    return;
  }

  try {
    // ── Step 1: Create upload task to get pre-signed URL ──
    const uploadTask = await fcFetch<{
      id: string;
      result: {
        form: {
          url: string;
          parameters: Record<string, string>;
        };
      };
    }>("POST", "/process/import/upload");

    // ── Step 2: Upload PDF to pre-signed URL ──
    const form = uploadTask.result.form;
    const formData = new FormData();
    for (const [key, val] of Object.entries(form.parameters)) {
      formData.append(key, val as string);
    }
    formData.append(
      "file",
      new Blob([pdfBuffer], { type: "application/pdf" }),
      "document.pdf",
    );

    const uploadRes = await fetch(form.url, {
      method: "POST",
      body: formData,
    });
    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      console.error("[convert-pdf] File upload failed:", uploadRes.status, errText);
      res.status(502).json({ error: "Failed to upload PDF for conversion" });
      return;
    }

    // ── Step 3: Create conversion job (convert → export) ──
    const job = await fcFetch<{
      id: string;
      status: string;
      tasks: Array<{ id: string; name: string; status: string; result?: { url?: string } }>;
    }>("POST", "/process/jobs", {
      tasks: {
        convert: {
          operation: "convert",
          input: uploadTask.id,
          output_format: "html",
        },
        export: {
          operation: "export/url",
          input: "convert",
          filename: "converted.html",
        },
      },
    });

    // ── Step 4: Poll job until complete ──
    const startTime = Date.now();
    let completedJob = job;

    while (Date.now() - startTime < POLL_TIMEOUT_MS) {
      if (completedJob.status === "completed") break;
      if (completedJob.status === "failed") {
        res.status(502).json({ error: "PDF conversion failed" });
        return;
      }

      await sleep(POLL_INTERVAL_MS);

      completedJob = await fcFetch<typeof job>("GET", `/process/jobs/${job.id}`);
    }

    if (completedJob.status !== "completed") {
      res.status(504).json({ error: "PDF conversion timed out. Please try again." });
      return;
    }

    // ── Step 5: Download HTML from export task's result URL ──
    const exportTask = completedJob.tasks.find((t) => t.name === "export");
    if (!exportTask?.result?.url) {
      res.status(502).json({ error: "Conversion completed but no download URL found" });
      return;
    }

    const htmlRes = await fetch(exportTask.result.url);
    if (!htmlRes.ok) {
      res.status(502).json({ error: "Failed to download converted HTML" });
      return;
    }

    const html = await htmlRes.text();
    res.json({ html });
  } catch (err) {
    console.error("[convert-pdf] Unexpected error:", err);
    res.status(500).json({ error: "Internal server error during PDF conversion" });
  }
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default router;
