import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Router } from "express";

const mockGenerateAnnotationsStream = vi.fn();
const mockMergeAnnotationsAndFeedback = vi.fn();
const mockRpc = vi.fn();
const mockUpsert = vi.fn();
const mockSingle = vi.fn();

vi.mock("../../lib/gemini.js", () => ({
  generateAnnotations: vi.fn(),
  generateAnnotationsStream: mockGenerateAnnotationsStream,
}));

vi.mock("../../lib/merge-annotations.js", () => ({
  mergeAnnotationsAndFeedback: mockMergeAnnotationsAndFeedback,
}));

vi.mock("../../lib/supabase.js", () => ({
  serviceClient: {
    rpc: mockRpc,
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      gt: vi.fn().mockReturnThis(),
      single: mockSingle,
      upsert: mockUpsert,
    })),
  },
}));

class MockRequest extends EventEmitter {
  method = "POST";
  url = "/";
  headers: Record<string, string>;
  body: unknown;
  user = {
    id: "user_1",
    email: "user@example.com",
    tier: "standard" as const,
  };

  constructor(body: unknown) {
    super();
    this.body = body;
    this.headers = {
      "content-type": "application/json",
      accept: "text/event-stream",
    };
  }
}

class MockResponse extends EventEmitter {
  statusCode = 200;
  writableEnded = false;
  private buffer = "";
  private resolveBody?: (value: string) => void;

  awaitBody(): Promise<string> {
    return new Promise((resolve) => {
      this.resolveBody = resolve;
    });
  }

  setHeader(): void {}

  flushHeaders(): void {}

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  json(payload: unknown): this {
    this.write(JSON.stringify(payload));
    this.end();
    return this;
  }

  write(chunk: string): boolean {
    this.buffer += chunk;
    return true;
  }

  end(chunk?: string): this {
    if (chunk) {
      this.write(chunk);
    }
    this.writableEnded = true;
    this.resolveBody?.(this.buffer);
    this.emit("close");
    return this;
  }
}

async function invokeRouter(router: Router, body: unknown): Promise<string> {
  const req = new MockRequest(body);
  const res = new MockResponse();
  const payloadPromise = res.awaitBody();
  let nextError: unknown;
  const directRouter = router as Router & {
    handle: (req: unknown, res: unknown, next: (error?: unknown) => void) => void;
  };

  directRouter.handle(req, res, (error?: unknown) => {
    nextError = error;
    if (!res.writableEnded) {
      res.end();
    }
  });

  const payload = await payloadPromise;
  if (nextError) throw nextError;
  return payload;
}

describe("annotate stream route", () => {
  beforeEach(() => {
    vi.resetModules();
    mockRpc.mockResolvedValue({
      data: { allowed: true, count: 1, already_counted: false },
      error: null,
    });
    mockSingle.mockResolvedValue({ data: null });
    mockUpsert.mockResolvedValue({ error: null });
    mockMergeAnnotationsAndFeedback.mockImplementation(async (annotations) => ({
      annotations,
      feedback: [],
    }));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("sends streamed annotations and a final authoritative done payload", async () => {
    const rawAnnotation = {
      id: "ann_1",
      mode: "overview",
      type: "core_claim",
      anchor: { type: "TextQuoteSelector", exact: "beta gamma" },
      content: { note: "Summary 1" },
    };
    const secondAnnotation = {
      id: "ann_2",
      mode: "overview",
      type: "core_claim",
      anchor: { type: "TextQuoteSelector", exact: "delta epsilon" },
      content: { note: "Summary 2" },
    };

    mockGenerateAnnotationsStream.mockImplementation(async (_text, _mode, _personality, options) => {
      options.onAnnotation?.(rawAnnotation);
      return {
        annotations: [rawAnnotation, secondAnnotation],
        usedBufferedFallback: true,
      };
    });

    const { default: annotateRouter } = await import("../annotate.js");
    const payload = await invokeRouter(annotateRouter, {
      url: "https://example.com/article",
      content_hash: "hash_123",
      text: "alpha beta gamma delta epsilon zeta eta theta",
      mode: "overview",
      word_count: 8,
    });

    expect(payload).toContain('"annotation":{"id":"ann_1"');
    expect(payload).toContain('"done":true');
    expect(payload).toContain('"annotations":[{"id":"ann_1"');
    expect(payload).toContain('"id":"ann_2"');
  });
});
