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
    expect(shared.RATE_LIMIT_FREE).toBe(50000);
    expect(shared.RATE_LIMIT_PRO).toBe(500);
  });

  it("exports request limit constants", () => {
    expect(shared.MAX_TEXT_LENGTH).toBe(100_000);
  });

  it("exports cache constants", () => {
    expect(shared.CACHE_TTL_DAYS).toBe(30);
  });

  it("exports annotation colors for all types (overview + depth + user_written)", () => {
    // 8 overview + 13 depth + 1 user_written = 22, but some overlap (assumption, caveat, consequence) so unique keys = 19
    const keys = Object.keys(shared.ANNOTATION_COLORS);
    expect(keys.length).toBeGreaterThanOrEqual(19);
    expect(shared.ANNOTATION_COLORS.core_claim).toBe("#4A90D9");
    expect(shared.ANNOTATION_COLORS.evidence).toBe("#7B61FF");
    expect(shared.ANNOTATION_COLORS.insight).toBe("#2ECC71");
    expect(shared.ANNOTATION_COLORS.vocabulary).toBe("#243C61");
    expect(shared.ANNOTATION_COLORS.user_written).toBe("#A1927B");
  });

  it("exports annotation labels for all types", () => {
    const keys = Object.keys(shared.ANNOTATION_LABELS);
    expect(keys.length).toBeGreaterThanOrEqual(19);
    expect(shared.ANNOTATION_LABELS.core_claim).toBe("CORE CLAIM");
    expect(shared.ANNOTATION_LABELS.counterargument).toBe("COUNTERARGUMENT");
    expect(shared.ANNOTATION_LABELS.user_written).toBe("MY NOTE");
  });

  it("exports ALL_OVERVIEW_TYPES with 8 entries", () => {
    expect(shared.ALL_OVERVIEW_TYPES).toHaveLength(8);
    expect(shared.ALL_OVERVIEW_TYPES).toContain("core_claim");
    expect(shared.ALL_OVERVIEW_TYPES).toContain("evidence");
    expect(shared.ALL_OVERVIEW_TYPES).toContain("assumption");
    expect(shared.ALL_OVERVIEW_TYPES).toContain("open_question");
  });

  it("exports ALL_DEPTH_TYPES with 13 entries", () => {
    expect(shared.ALL_DEPTH_TYPES).toHaveLength(13);
    expect(shared.ALL_DEPTH_TYPES).toContain("counterargument");
    expect(shared.ALL_DEPTH_TYPES).toContain("insight");
    expect(shared.ALL_DEPTH_TYPES).toContain("vocabulary");
    expect(shared.ALL_DEPTH_TYPES).toContain("recall");
  });
});
