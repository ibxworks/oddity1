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

  it("exports plan features and canUseFeature helper", () => {
    expect(shared.PLAN_FEATURES.free.readingPersonality).toBe(false);
    expect(shared.PLAN_FEATURES.standard.readingPersonality).toBe(true);
    expect(shared.canUseFeature("free", "readingPersonality")).toBe(false);
    expect(shared.canUseFeature("standard", "readingPersonality")).toBe(true);
  });

  it("exports request limit constants", () => {
    expect(shared.MAX_TEXT_LENGTH).toBe(100_000);
  });

  it("exports cache constants", () => {
    expect(shared.CACHE_TTL_DAYS).toBe(30);
  });

  it("exports annotation colors for all types (overview + depth + user_written)", () => {
    // 5 overview + 12 depth + 1 user_written = 18, but consequence overlaps so unique keys = 17
    const keys = Object.keys(shared.ANNOTATION_COLORS);
    expect(keys.length).toBeGreaterThanOrEqual(17);
    expect(shared.ANNOTATION_COLORS.core_claim).toBe("#FFDD69");
    expect(shared.ANNOTATION_COLORS.evidence).toBe("#FFDD69");
    expect(shared.ANNOTATION_COLORS.outcome).toBe("#FFDD69");
    expect(shared.ANNOTATION_COLORS.caveat).toBe("#F5574C");
    expect(shared.ANNOTATION_COLORS.insight).toBe("#578E6C");
    expect(shared.ANNOTATION_COLORS.vocabulary).toBe("#578E6C");
    expect(shared.ANNOTATION_COLORS.user_written).toBe("#748DBF");
  });

  it("exports annotation labels for all types", () => {
    const keys = Object.keys(shared.ANNOTATION_LABELS);
    expect(keys.length).toBeGreaterThanOrEqual(17);
    expect(shared.ANNOTATION_LABELS.core_claim).toBe("CORE CLAIM");
    expect(shared.ANNOTATION_LABELS.counterargument).toBe("COUNTERARGUMENT");
    expect(shared.ANNOTATION_LABELS.user_written).toBe("MY NOTE");
  });

  it("exports ALL_OVERVIEW_TYPES with 5 entries", () => {
    expect(shared.ALL_OVERVIEW_TYPES).toHaveLength(5);
    expect(shared.ALL_OVERVIEW_TYPES).toContain("core_claim");
    expect(shared.ALL_OVERVIEW_TYPES).toContain("evidence");
    expect(shared.ALL_OVERVIEW_TYPES).toContain("outcome");
    expect(shared.ALL_OVERVIEW_TYPES).toContain("background");
    expect(shared.ALL_OVERVIEW_TYPES).toContain("transition");
  });

  it("exports ALL_DEPTH_TYPES with 21 entries", () => {
    expect(shared.ALL_DEPTH_TYPES).toHaveLength(21);
    expect(shared.ALL_DEPTH_TYPES).toContain("counterargument");
    expect(shared.ALL_DEPTH_TYPES).toContain("insight");
    expect(shared.ALL_DEPTH_TYPES).toContain("vocabulary");
    expect(shared.ALL_DEPTH_TYPES).toContain("recall");
  });
});
