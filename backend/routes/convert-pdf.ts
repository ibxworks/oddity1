import type { UserTier } from "@oddity/shared";
import { canUseFeature } from "@oddity/shared";
import { Router } from "express";

const DATALAB_API_URL = "https://www.datalab.to/api/v1/marker";
const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 55_000; // Leave margin within Vercel's 60s limit
const MAX_PDF_SIZE = 3 * 1024 * 1024; // 3MB raw PDF

const router = Router();

router.post("/", async (req, res) => {
  const apiKey = process.env.MARKER_API_KEY;
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
    // ── Submit to Marker API ──
    const formData = new FormData();
    formData.append(
      "file",
      new Blob([pdfBuffer], { type: "application/pdf" }),
      "document.pdf",
    );
    formData.append("output_format", "html");
    formData.append("mode", "fast");

    const submitRes = await fetch(DATALAB_API_URL, {
      method: "POST",
      headers: { "X-API-Key": apiKey },
      body: formData,
    });

    if (!submitRes.ok) {
      const errBody = await submitRes.text();
      console.error("[convert-pdf] Marker submit failed:", submitRes.status, errBody);
      res.status(502).json({ error: "PDF conversion service error" });
      return;
    }

    const submitData = (await submitRes.json()) as {
      success: boolean;
      request_check_url?: string;
      request_id?: string;
    };

    if (!submitData.success || !submitData.request_check_url) {
      console.error("[convert-pdf] Marker submit rejected:", submitData);
      res.status(502).json({ error: "PDF conversion service rejected the request" });
      return;
    }

    // ── Poll for result ──
    const checkUrl = submitData.request_check_url;
    const startTime = Date.now();

    while (Date.now() - startTime < POLL_TIMEOUT_MS) {
      await sleep(POLL_INTERVAL_MS);

      const pollRes = await fetch(checkUrl, {
        headers: { "X-API-Key": apiKey },
      });

      if (!pollRes.ok) {
        console.error("[convert-pdf] Marker poll failed:", pollRes.status);
        continue;
      }

      const pollData = (await pollRes.json()) as {
        status: string;
        success?: boolean;
        html?: string;
        images?: Record<string, string>;
        error?: string;
      };

      if (pollData.status === "complete") {
        if (!pollData.success || !pollData.html) {
          res.status(502).json({
            error: pollData.error ?? "PDF conversion failed",
          });
          return;
        }

        // Inline base64 images into the HTML
        const html = inlineImages(pollData.html, pollData.images ?? {});
        res.json({ html });
        return;
      }

      if (pollData.status === "failed") {
        res.status(502).json({
          error: pollData.error ?? "PDF conversion failed",
        });
        return;
      }

      // status is "processing" — keep polling
    }

    // Timeout
    res.status(504).json({ error: "PDF conversion timed out. Please try again." });
  } catch (err) {
    console.error("[convert-pdf] Unexpected error:", err);
    res.status(500).json({ error: "Internal server error during PDF conversion" });
  }
});

/**
 * Replace `<img src="filename.png">` references with inline base64 data URIs.
 * Marker returns images as `{ "filename.png": "base64data..." }`.
 */
function inlineImages(html: string, images: Record<string, string>): string {
  if (Object.keys(images).length === 0) return html;

  return html.replace(
    /<img\s+([^>]*?)src=["']([^"']+)["']/gi,
    (match, before: string, src: string) => {
      const base64 = images[src];
      if (!base64) return match;

      // Detect MIME from filename extension
      const ext = src.split(".").pop()?.toLowerCase() ?? "png";
      const mime =
        ext === "jpg" || ext === "jpeg"
          ? "image/jpeg"
          : ext === "gif"
            ? "image/gif"
            : ext === "webp"
              ? "image/webp"
              : "image/png";

      return `<img ${before}src="data:${mime};base64,${base64}"`;
    },
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default router;
