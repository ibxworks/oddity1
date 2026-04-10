import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StabilitySignal } from "@oddity/shared";
import { createChatObserver } from "../chat-observer.js";

const SCAN_DEBOUNCE_MS = 200;
const COMPLETION_SETTLE_MS = 1200;

function makeResponse(options?: {
  complete?: boolean;
  streaming?: boolean;
}): HTMLDivElement {
  const response = document.createElement("div");
  response.className = "response";
  response.innerHTML = `
    <p>
      This is a sufficiently long chatbot response with enough words to exceed
      the minimum completion threshold for the observer.
    </p>
  `;

  if (options?.streaming !== false) {
    const cursor = document.createElement("div");
    cursor.className = "result-streaming";
    response.appendChild(cursor);
  }

  if (options?.complete) {
    const copyButton = document.createElement("button");
    copyButton.className = "copy";
    response.appendChild(copyButton);
  }

  return response;
}

async function flushMutations(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function discoverDynamicResponse(): Promise<void> {
  await flushMutations();
  vi.advanceTimersByTime(SCAN_DEBOUNCE_MS);
  await flushMutations();
}

describe("createChatObserver", () => {
  const stabilitySignal: StabilitySignal = {
    type: "selector_appears",
    target_selector: ".copy",
  };

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("does not fire early for a pre-existing response that is still streaming", async () => {
    document.body.appendChild(makeResponse({ streaming: true }));

    const onResponse = vi.fn();
    const observer = createChatObserver({
      responseSelector: ".response",
      stabilitySignal,
      onResponse,
    });

    observer.start();
    await flushMutations();

    expect(onResponse).not.toHaveBeenCalled();

    vi.advanceTimersByTime(COMPLETION_SETTLE_MS - 1);
    await flushMutations();

    expect(onResponse).not.toHaveBeenCalled();
    observer.stop();
  });

  it("fires once immediately for a completed response already present at startup", async () => {
    document.body.appendChild(makeResponse({ complete: true, streaming: false }));

    const onResponse = vi.fn();
    const observer = createChatObserver({
      responseSelector: ".response",
      stabilitySignal,
      onResponse,
    });

    observer.start();
    await flushMutations();

    expect(onResponse).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(COMPLETION_SETTLE_MS * 2);
    await flushMutations();

    expect(onResponse).toHaveBeenCalledTimes(1);
    observer.stop();
  });

  it("finalizes immediately when the completion signal appears", async () => {
    const onResponse = vi.fn();
    const observer = createChatObserver({
      responseSelector: ".response",
      stabilitySignal,
      onResponse,
    });

    observer.start();

    const response = makeResponse({ streaming: true });
    document.body.appendChild(response);
    await discoverDynamicResponse();

    expect(onResponse).not.toHaveBeenCalled();

    response.querySelector(".result-streaming")?.remove();
    const copyButton = document.createElement("button");
    copyButton.className = "copy";
    response.appendChild(copyButton);
    await flushMutations();

    expect(onResponse).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(COMPLETION_SETTLE_MS * 2);
    await flushMutations();

    expect(onResponse).toHaveBeenCalledTimes(1);
    observer.stop();
  });

  it("releases tracked elements after completion", async () => {
    const tracked = new Set<Element>();
    const observer = createChatObserver({
      responseSelector: ".response",
      stabilitySignal,
      onResponse: vi.fn(),
      onTrack: (element) => tracked.add(element),
      onUntrack: (element) => tracked.delete(element),
    });

    observer.start();

    const response = makeResponse({ streaming: true });
    document.body.appendChild(response);
    await discoverDynamicResponse();

    expect(tracked.has(response)).toBe(true);

    response.querySelector(".result-streaming")?.remove();
    const copyButton = document.createElement("button");
    copyButton.className = "copy";
    response.appendChild(copyButton);
    await flushMutations();

    expect(tracked.has(response)).toBe(false);
    observer.stop();
  });

  it("falls back to the settle timer when no stability signal is configured", async () => {
    const onResponse = vi.fn();
    const observer = createChatObserver({
      responseSelector: ".response",
      stabilitySignal: null,
      onResponse,
    });

    observer.start();

    document.body.appendChild(makeResponse({ streaming: false }));
    await discoverDynamicResponse();

    expect(onResponse).not.toHaveBeenCalled();

    vi.advanceTimersByTime(COMPLETION_SETTLE_MS - 1);
    await flushMutations();
    expect(onResponse).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    await flushMutations();
    expect(onResponse).toHaveBeenCalledTimes(1);

    observer.stop();
  });
});
