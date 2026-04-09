import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Annotation } from "@oddity/shared";

vi.mock("../renderer/arguments-box.js", () => ({
  addLiveFeedback: vi.fn(() => "live-feedback-1"),
  updateLiveFeedbackId: vi.fn(),
}));

import {
  createNoteElementForTest,
  resolveMarginNoteHeaderAuthor,
  setMarginNotesPersonality,
  setMarginNotesUserName,
  syncNoteHeaderAttributionForTest,
  type MarginNoteAttributionState,
} from "../renderer/margin-notes.js";
import { setThemeOverride } from "../renderer/theme-detector.js";

function makeAnnotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: "ann-1",
    mode: "depth",
    type: "insight",
    label: "The incumbent's trap",
    anchor: {
      type: "TextQuoteSelector",
      exact: "Being cash-rich is a liability when it breeds complacency.",
    },
    content: {
      note: "Being cash-rich is a liability when it breeds complacency.",
    },
    ...overrides,
  };
}

describe("resolveMarginNoteHeaderAuthor", () => {
  it("uses the selected depth personality for AI depth annotations", () => {
    const attribution: MarginNoteAttributionState = {
      selectedPersonality: "terry",
      selectedPersonalityDisplayName: "Terry",
      userDisplayName: "Tony Park",
    };

    expect(resolveMarginNoteHeaderAuthor(makeAnnotation(), attribution)).toBe("Terry");
  });

  it("hides author text for overview annotations and unresolved PF names", () => {
    const unresolvedPf: MarginNoteAttributionState = {
      selectedPersonality: "pf:steve_jobs",
      selectedPersonalityDisplayName: null,
      userDisplayName: "Tony Park",
    };

    expect(resolveMarginNoteHeaderAuthor(makeAnnotation(), unresolvedPf)).toBeNull();
    expect(
      resolveMarginNoteHeaderAuthor(
        makeAnnotation({ mode: "overview", type: "core_claim" }),
        {
          ...unresolvedPf,
          selectedPersonalityDisplayName: "Steve Jobs",
        },
      ),
    ).toBeNull();
  });

  it("uses the user display name for manual annotations", () => {
    const attribution: MarginNoteAttributionState = {
      selectedPersonality: "jerry",
      selectedPersonalityDisplayName: "Jerry",
      userDisplayName: "Tony Park",
    };

    expect(
      resolveMarginNoteHeaderAuthor(
        makeAnnotation({ id: "manual-1", type: "user_written" }),
        attribution,
      ),
    ).toBe("Tony Park");
  });
});

describe("margin note header rendering", () => {
  beforeEach(() => {
    document.body.innerHTML = "<main><p>Test page</p></main>";
    setThemeOverride("light");
    setMarginNotesUserName(null);
    setMarginNotesPersonality(null);
  });

  it("shows the correct PF display name in the depth note header without a title badge", () => {
    setMarginNotesPersonality("pf:steve_jobs", "Steve Jobs");

    const note = createNoteElementForTest(makeAnnotation());
    const header = note.querySelector(".note-header");
    const author = note.querySelector(".note-persona");

    expect(header?.classList.contains("note-header--copy-only")).toBe(false);
    expect(author?.textContent).toBe("Steve Jobs");
    expect((author as HTMLSpanElement).hidden).toBe(false);
    expect(note.querySelector(".note-persona-tag")).toBeNull();
    expect(note.querySelector(".note-user-badge")).toBeNull();
  });

  it("shows the user name for manual notes without a duplicate title badge", () => {
    setMarginNotesUserName("Tony Park");
    setMarginNotesPersonality("jerry");

    const note = createNoteElementForTest(
      makeAnnotation({
        id: "manual-1",
        type: "user_written",
        label: "MY NOTE",
        content: { note: "very true" },
      }),
    );

    const author = note.querySelector(".note-persona") as HTMLSpanElement | null;
    expect(author?.textContent).toBe("Tony Park");
    expect(author?.hidden).toBe(false);
    expect(note.querySelector(".note-user-badge")).toBeNull();
  });

  it("keeps overview headers copy-only and hides author text", () => {
    setMarginNotesPersonality("pf:richard_feynman", "Richard Feynman");

    const note = createNoteElementForTest(
      makeAnnotation({
        mode: "overview",
        type: "core_claim",
        label: "Valuations Supported by Earnings",
      }),
    );

    const header = note.querySelector(".note-header") as HTMLDivElement | null;
    const author = note.querySelector(".note-persona") as HTMLSpanElement | null;
    const copyBtn = note.querySelector(".note-copy-btn");

    expect(header?.classList.contains("note-header--copy-only")).toBe(true);
    expect(author?.hidden).toBe(true);
    expect(author?.textContent).toBe("");
    expect(copyBtn).not.toBeNull();
  });

  it("refreshes an existing depth header when the PF display name arrives later", () => {
    const annotation = makeAnnotation();
    setMarginNotesPersonality("pf:steve_jobs", null);

    const note = createNoteElementForTest(annotation);
    const header = note.querySelector(".note-header") as HTMLDivElement;
    const author = note.querySelector(".note-persona") as HTMLSpanElement;

    expect(header.classList.contains("note-header--copy-only")).toBe(true);
    expect(author.hidden).toBe(true);

    setMarginNotesPersonality("pf:steve_jobs", "Steve Jobs");
    syncNoteHeaderAttributionForTest(note, annotation);

    expect(header.classList.contains("note-header--copy-only")).toBe(false);
    expect(author.hidden).toBe(false);
    expect(author.textContent).toBe("Steve Jobs");
  });
});
