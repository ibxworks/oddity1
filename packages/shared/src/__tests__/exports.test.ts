import { describe, expect, it } from "vitest";
import * as shared from "../index.js";

describe("@oddity/shared exports", () => {
  it("exports BACKEND_URL", () => {
    expect(shared.BACKEND_URL).toBeDefined();
  });

  it("exports timing constants", () => {
    expect(shared.STABILITY_DEBOUNCE_MS).toBe(500);
    expect(shared.POPOVER_SHOW_DELAY_MS).toBe(200);
    expect(shared.POPOVER_HIDE_DELAY_MS).toBe(300);
    expect(shared.ADAPTER_REFRESH_INTERVAL_MINUTES).toBe(360);
    expect(shared.SCROLL_LOADER_ROOT_MARGIN).toBe("500px");
    expect(shared.EAGER_WORD_LIMIT).toBe(6000);
  });

  it("exports rate limit constants", () => {
    expect(shared.RATE_LIMIT_FREE).toBe(50);
    expect(shared.RATE_LIMIT_PRO).toBe(500);
  });

  it("exports request limit constants", () => {
    expect(shared.MAX_TEXT_LENGTH).toBe(100_000);
  });

  it("exports cache constants", () => {
    expect(shared.CACHE_TTL_DAYS).toBe(30);
  });

  it("exports annotation colors for all 15 types", () => {
    expect(Object.keys(shared.ANNOTATION_COLORS)).toHaveLength(15);
    expect(shared.ANNOTATION_COLORS.provocation).toBe("#F5574C");
    expect(shared.ANNOTATION_COLORS.caveat).toBe("#F5574C");
    expect(shared.ANNOTATION_COLORS["hedge-check"]).toBe("#F5574C");
    expect(shared.ANNOTATION_COLORS.insight).toBe("#BFF3D3");
    expect(shared.ANNOTATION_COLORS.free).toBe("#BFF3D3");
    expect(shared.ANNOTATION_COLORS.structural).toBe("#243C61");
    expect(shared.ANNOTATION_COLORS.recall).toBe("#243C61");
    expect(shared.ANNOTATION_COLORS.vocab).toBe("#FFDD69");
    expect(shared.ANNOTATION_COLORS.translation).toBe("#FFDD69");
  });

  it("exports annotation labels for all 15 types", () => {
    expect(Object.keys(shared.ANNOTATION_LABELS)).toHaveLength(15);
    expect(shared.ANNOTATION_LABELS.provocation).toBe("PROVOCATION");
    expect(shared.ANNOTATION_LABELS.recall).toBe("RECALL");
    expect(shared.ANNOTATION_LABELS.vocab).toBe("VOCAB");
  });

  it("exports ALL_ANNOTATION_TYPES with 15 entries", () => {
    expect(shared.ALL_ANNOTATION_TYPES).toHaveLength(15);
    expect(shared.ALL_ANNOTATION_TYPES).toContain("provocation");
    expect(shared.ALL_ANNOTATION_TYPES).toContain("recall");
    expect(shared.ALL_ANNOTATION_TYPES).toContain("insight");
    expect(shared.ALL_ANNOTATION_TYPES).toContain("vocab");
  });
});
