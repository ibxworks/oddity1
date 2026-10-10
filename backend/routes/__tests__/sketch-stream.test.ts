import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Router } from "express";

const mockGenerateSketchStream = vi.fn();

vi.mock("../../lib/llm.js", () => ({
  generateSketchStream: mockGenerateSketchStream,
}));

vi.mock("../../lib/llm-config.js", () => ({
  resolveRequestLlm: vi.fn(async () => ({
    override: null,
    bypassLimits: false,
    cacheTag: null,
  })),
  sendLlmConfigError: vi.fn((_res: unknown, _err: unknown): boolean => false),
}));

class MockRequest extends EventEmitter {
  method = "POST";
  url = "/";
  headers = {
    "content-type": "application/json",
    accept: "text/event-stream",
  };
  user = {
    id: "user_1",
    email: "user@example.com",
    tier: "standard" as const,
  };

  constructor(public body: unknown) {
    super();
  }
}

class MockResponse extends EventEmitter {
  writableEnded = false;
  private buffer = "";
  private resolveBody?: (value: string) => void;

  awaitBody(): Promise<string> {
    return new Promise((resolve) => {
      this.resolveBody = resolve;
    });
  }

  statusCode = 200;

  setHeader(): void {}

  flushHeaders(): void {}

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  json(payload: unknown): this {
    this.write(JSON.stringify({ httpStatus: this.statusCode, body: payload }));
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

describe("sketch stream route", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("accepts empty user reactions and still streams a result", async () => {
    mockGenerateSketchStream.mockImplementation(async (_input, _purpose, _reactions, _mode, options) => {
      options.onChunk?.("prompt body");
    });

    const { default: sketchRouter } = await import("../sketch.js");
    const payload = await invokeRouter(sketchRouter, {
      input_text: "hello world",
      purpose: "turn this into a prompt",
      user_reactions: "",
      mode: "prompt",
    });

    expect(mockGenerateSketchStream).toHaveBeenCalledWith(
      "hello world",
      "turn this into a prompt",
      "",
      "prompt",
      expect.objectContaining({
        onChunk: expect.any(Function),
      }),
    );
    expect(payload).toContain('"text":"prompt body"');
    expect(payload).toContain('"done":true');
  });

  it("defaults omitted user reactions to an empty string", async () => {
    mockGenerateSketchStream.mockImplementation(async (_input, _purpose, _reactions, _mode, options) => {
      options.onChunk?.("outline");
    });

    const { default: sketchRouter } = await import("../sketch.js");
    const payload = await invokeRouter(sketchRouter, {
      input_text: "hello world",
      purpose: "make a sketch",
    });

    expect(mockGenerateSketchStream).toHaveBeenCalledWith(
      "hello world",
      "make a sketch",
      "",
      "sketch",
      expect.objectContaining({
        onChunk: expect.any(Function),
      }),
    );
    expect(payload).toContain('"text":"outline"');
    expect(payload).toContain('"done":true');
  });

  it("returns a graceful SSE error if the stream fails after partial output", async () => {
    mockGenerateSketchStream.mockImplementation(async (_input, _purpose, _reactions, _mode, options) => {
      options.onChunk?.("hello");
      throw new Error("stream parse failed");
    });

    const { default: sketchRouter } = await import("../sketch.js");
    const payload = await invokeRouter(sketchRouter, {
      input_text: "hello world",
      purpose: "test",
      user_reactions: "none",
    });

    expect(payload).toContain('"text":"hello"');
    expect(payload).toContain('"error":"Internal server error"');
  });

  it("threads the BYOK override into the sketch generator", async () => {
    const override = {
      provider: "anthropic",
      transport: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      apiKeys: ["user-key"],
      model: "claude-sonnet-4-5",
      effort: "medium",
    };
    const llmConfig = await import("../../lib/llm-config.js");
    vi.mocked(llmConfig.resolveRequestLlm).mockResolvedValueOnce({
      override,
      bypassLimits: true,
      cacheTag: "anthropic:claude-sonnet-4-5:medium:abc123def456",
    });
    mockGenerateSketchStream.mockImplementation(
      async (_input, _purpose, _reactions, _mode, options) => {
        options.onChunk?.("byok sketch");
      },
    );

    const { default: sketchRouter } = await import("../sketch.js");
    const payload = await invokeRouter(sketchRouter, {
      input_text: "hello world",
      purpose: "make a sketch",
    });

    expect(mockGenerateSketchStream).toHaveBeenCalledWith(
      "hello world",
      "make a sketch",
      "",
      "sketch",
      expect.objectContaining({ override }),
    );
    expect(payload).toContain('"text":"byok sketch"');
  });

  it("answers config errors via the shared sender instead of generating", async () => {
    const llmConfig = await import("../../lib/llm-config.js");
    const configError = new Error("Selected provider has no API key");
    vi.mocked(llmConfig.resolveRequestLlm).mockRejectedValueOnce(configError);
    vi.mocked(llmConfig.sendLlmConfigError).mockImplementationOnce(
      (res, err) => {
        (res as MockResponse).write(`config-error:${(err as Error).message}`);
        (res as MockResponse).end();
        return true;
      },
    );

    const { default: sketchRouter } = await import("../sketch.js");
    const payload = await invokeRouter(sketchRouter, {
      input_text: "hello world",
      purpose: "make a sketch",
    });

    expect(llmConfig.sendLlmConfigError).toHaveBeenCalledWith(
      expect.anything(),
      configError,
    );
    expect(mockGenerateSketchStream).not.toHaveBeenCalled();
    expect(payload).toContain("config-error:Selected provider has no API key");
  });

  it("returns 500 instead of hanging on unexpected resolver failures", async () => {
    const llmConfig = await import("../../lib/llm-config.js");
    vi.mocked(llmConfig.resolveRequestLlm).mockRejectedValueOnce(
      new Error("supabase down"),
    );

    const { default: sketchRouter } = await import("../sketch.js");
    const payload = await invokeRouter(sketchRouter, {
      input_text: "hello world",
      purpose: "make a sketch",
    });

    expect(mockGenerateSketchStream).not.toHaveBeenCalled();
    expect(payload).toContain('"httpStatus":500');
    expect(payload).toContain('"error":"Internal server error"');
  });
});
