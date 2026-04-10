import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendMessageMock } = vi.hoisted(() => ({
  sendMessageMock: vi.fn(),
}));

vi.mock("../../shared/messaging.js", () => ({
  sendMessage: sendMessageMock,
}));

import {
  canUseNativeGDocsHighlights,
  findAnnotationRects,
  handleGDocsNativeHighlightError,
  resetGDocsNativeHighlightStateForTest,
  setCachedGDocsTextForTest,
} from "../google-docs.js";

type RectSpec = {
  left: number;
  top: number;
  width: number;
  height: number;
  right?: number;
  bottom?: number;
  x?: number;
  y?: number;
};

function setRect(element: Element, rect: RectSpec): void {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () =>
      ({
        x: rect.x ?? rect.left ?? 0,
        y: rect.y ?? rect.top ?? 0,
        left: rect.left ?? rect.x ?? 0,
        top: rect.top ?? rect.y ?? 0,
        width: rect.width ?? 0,
        height: rect.height ?? 0,
        right: rect.right ?? (rect.left ?? rect.x ?? 0) + (rect.width ?? 0),
        bottom: rect.bottom ?? (rect.top ?? rect.y ?? 0) + (rect.height ?? 0),
        toJSON: () => rect,
      }) as DOMRect,
  });
}

describe("Google Docs canvas fallback", () => {
  beforeEach(() => {
    resetGDocsNativeHighlightStateForTest();
    sendMessageMock.mockReset();
    document.body.innerHTML = "";
    window.history.replaceState(
      {},
      "",
      "/document/d/test-doc-id/edit",
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});

    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => {
      return {
        font: "",
        measureText: (text: string) => ({ width: Math.max(text.length * 7, 1) }),
        getImageData: () => ({
          data: new Uint8ClampedArray(4),
          width: 1,
          height: 1,
        }),
      } as unknown as CanvasRenderingContext2D;
    });
  });

  it("returns an approximate rect immediately even when native correction fails", async () => {
    sendMessageMock.mockResolvedValue({
      error: "GDocsAuthConfigError:bad client id",
    });

    const scrollContainer = document.createElement("div");
    scrollContainer.className = "kix-paginateddocumentplugin";
    const page = document.createElement("div");
    page.className = "kix-page";
    const canvas = document.createElement("canvas");
    const paragraph = document.createElement("div");
    paragraph.className = "kix-paragraphrenderer";
    paragraph.textContent = "A critical sentence worth annotating.";

    page.append(canvas, paragraph);
    scrollContainer.appendChild(page);
    document.body.appendChild(scrollContainer);

    setRect(page, { left: 100, top: 40, width: 816, height: 1056 });
    setRect(canvas, { left: 100, top: 40, width: 816, height: 1056 });
    setRect(paragraph, { left: 196, top: 136, width: 624, height: 18 });

    setCachedGDocsTextForTest("A critical sentence worth annotating.");

    const annotation = {
      id: "ann-1",
      type: "insight",
      anchor: { exact: "critical sentence" },
    };

    const result = findAnnotationRects(
      {
        id: "google-docs-document",
        element: scrollContainer,
        source: "adapter",
      },
      annotation as any,
    );

    expect(result.rects).toHaveLength(1);
    expect(result.rects[0]?.width).toBeGreaterThan(0);
    expect(result.anchorNode).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(canUseNativeGDocsHighlights()).toBe(false);
  });

  it("disables repeated native highlight attempts after the first config failure", () => {
    const warnSpy = vi.spyOn(console, "warn");

    expect(canUseNativeGDocsHighlights()).toBe(true);
    expect(
      handleGDocsNativeHighlightError("GDocsAuthConfigError:bad client id"),
    ).toBe(true);
    expect(
      handleGDocsNativeHighlightError("GDocsAuthConfigError:bad client id"),
    ).toBe(true);
    expect(canUseNativeGDocsHighlights()).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
