import { describe, expect, it } from "vitest";
import type { Annotation } from "@oddity/shared";
import {
  annotateDocument,
  buildExportDocument,
  dedupeTitleHeading,
  renderNoteHtml,
  sanitizeExportHtml,
  titleCaseLabel,
} from "../export-pdf.js";

function makeAnnotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: "ann-1",
    mode: "depth",
    type: "insight",
    anchor: { type: "TextQuoteSelector", exact: "target phrase" },
    content: { note: "A note about the phrase." },
    ...overrides,
  };
}

const DOC_OPTS = {
  title: "Test Article",
  subtitle: "Created with Oddity 1",
  sourceUrl: "https://example.com/article",
  fontFamily: "Georgia, serif",
  noteSize: "14px",
  gfontCss: undefined,
};

describe("sanitizeExportHtml", () => {
  it("strips nav/header/footer/aside landmarks", () => {
    const html = sanitizeExportHtml(
      `<nav>menu</nav><header>banner</header><aside>side</aside>` +
        `<footer>foot</footer><article><p>Keep me</p></article>`,
    );
    expect(html).toContain("Keep me");
    expect(html).not.toContain("menu");
    expect(html).not.toContain("banner");
    expect(html).not.toContain("foot");
  });

  it("removes back-links like '← Posts' but keeps content links", () => {
    const html = sanitizeExportHtml(
      `<p><a href="/posts">← Posts</a></p><p>Read <a href="/x">this analysis</a> now</p>`,
    );
    expect(html).not.toContain("← Posts");
    expect(html).toContain("this analysis");
  });

  it("strips classes, styles, and handlers while keeping hrefs", () => {
    const html = sanitizeExportHtml(
      `<p class="fancy" style="color:red" onclick="x()">Hi <a class="l" href="/x">there</a></p>`,
    );
    expect(html).not.toContain("fancy");
    expect(html).not.toContain("color:red");
    expect(html).not.toContain("onclick");
    expect(html).toContain('href="/x"');
  });
});

describe("dedupeTitleHeading", () => {
  it("removes the first heading when it repeats the title", () => {
    const host = document.createElement("div");
    host.innerHTML = `<h1>Test Article</h1><p>Body</p>`;
    dedupeTitleHeading(host, "Test Article");
    expect(host.querySelector("h1")).toBeNull();
    expect(host.textContent).toContain("Body");
  });

  it("removes the heading when the title has a site suffix", () => {
    const host = document.createElement("div");
    host.innerHTML = `<h1>Test Article</h1><p>Body</p>`;
    dedupeTitleHeading(host, "Test Article | Tony Park");
    expect(host.querySelector("h1")).toBeNull();
  });

  it("keeps a heading that differs from the title", () => {
    const host = document.createElement("div");
    host.innerHTML = `<h1>Something Else</h1><p>Body</p>`;
    dedupeTitleHeading(host, "Test Article");
    expect(host.querySelector("h1")).not.toBeNull();
  });
});

describe("annotateDocument", () => {
  it("wraps anchors, numbers in DOM order, and links refs to notes", () => {
    const host = document.createElement("div");
    host.innerHTML = `<p>First target phrase here. Second target phrase there.</p>`;
    const a1 = makeAnnotation({
      id: "second",
      anchor: { type: "TextQuoteSelector", exact: "Second target phrase" },
    });
    const a2 = makeAnnotation({
      id: "first",
      anchor: { type: "TextQuoteSelector", exact: "First target phrase" },
    });
    // Pass out of order: numbers must follow DOM order, not input order.
    const notes = annotateDocument(host, [a1, a2]);

    expect(host.querySelectorAll("mark[data-note-id]").length).toBe(2);
    expect(notes.map((n) => n.number)).toEqual([1, 2]);
    expect(notes[0]!.annotation.id).toBe("first");
    expect(notes[1]!.annotation.id).toBe("second");
    const refs = host.querySelectorAll("a.fnref");
    expect(refs.length).toBe(2);
    expect(refs[0]!.getAttribute("href")).toBe("#note-1");
  });

  it("matches across whitespace differences and inline tags", () => {
    const host = document.createElement("div");
    host.innerHTML = `<p>Some   text with <strong>bold words</strong> inside.</p>`;
    const ann = makeAnnotation({
      anchor: { type: "TextQuoteSelector", exact: "text with bold words inside" },
    });
    const notes = annotateDocument(host, [ann]);
    expect(notes[0]!.number).toBe(1);
    expect(host.querySelector("mark[data-note-id]")).not.toBeNull();
  });

  it("falls back to case-insensitive matching", () => {
    const host = document.createElement("div");
    host.innerHTML = `<p>The Market crashed hard.</p>`;
    const ann = makeAnnotation({
      anchor: { type: "TextQuoteSelector", exact: "the market crashed" },
    });
    const notes = annotateDocument(host, [ann]);
    expect(notes[0]!.number).toBe(1);
  });

  it("quotes the actual page text, not the anchor spelling", () => {
    const host = document.createElement("div");
    host.innerHTML = `<p>Citadel, the American mega-fund, threw hardest.</p>`;
    const ann = makeAnnotation({
      anchor: { type: "TextQuoteSelector", exact: "citadel, the american mega-fund" },
    });
    const notes = annotateDocument(host, [ann]);
    expect(notes[0]!.quote).toBe("Citadel, the American mega-fund");
  });

  it("demotes nested shorter anchors and empty anchors to unnumbered notes", () => {
    const host = document.createElement("div");
    host.innerHTML = `<p>Leveraged bets had piled up too heavily.</p>`;
    const long = makeAnnotation({
      id: "long",
      anchor: { type: "TextQuoteSelector", exact: "Leveraged bets had piled up too heavily" },
    });
    const short = makeAnnotation({
      id: "short",
      anchor: { type: "TextQuoteSelector", exact: "piled up" },
    });
    const empty = makeAnnotation({ id: "empty", anchor: { type: "TextQuoteSelector", exact: "" } });
    const notes = annotateDocument(host, [short, empty, long]);

    expect(host.querySelectorAll("mark[data-note-id]").length).toBe(1);
    expect(notes.find((n) => n.annotation.id === "long")!.number).toBe(1);
    expect(notes.find((n) => n.annotation.id === "short")!.number).toBeNull();
    expect(notes.find((n) => n.annotation.id === "empty")!.number).toBeNull();
    // No annotation is dropped.
    expect(notes.length).toBe(3);
  });
});

describe("renderNoteHtml", () => {
  it("renders bold and bullets", () => {
    const html = renderNoteHtml("**Frames investing** as a test\n- one\n- two");
    expect(html).toContain("<strong>Frames investing</strong>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>one</li>");
  });

  it("escapes HTML so annotation text cannot inject markup", () => {
    const html = renderNoteHtml(`<script>alert(1)</script> **bold**`);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("<strong>bold</strong>");
  });
});

describe("titleCaseLabel", () => {
  it("prefers the LLM label when present", () => {
    expect(titleCaseLabel(makeAnnotation({ label: "Thesis: market as exam" }))).toBe(
      "Thesis: market as exam",
    );
  });

  it("converts screaming labels to title case with spaces", () => {
    expect(titleCaseLabel(makeAnnotation({ type: "counterargument" }))).toBe("Counterargument");
    expect(titleCaseLabel(makeAnnotation({ type: "fixation_breaker" }))).toBe(
      "Fixation breaker",
    );
    expect(titleCaseLabel(makeAnnotation({ type: "user_written" }))).toBe("My note");
  });
});

describe("buildExportDocument", () => {
  function buildDoc() {
    const host = document.createElement("div");
    host.innerHTML = `<p>First target phrase here.</p>`;
    const notes = annotateDocument(host, [makeAnnotation()]);
    return buildExportDocument({ ...DOC_OPTS, bodyHtml: host.innerHTML, notes });
  }

  it("renders header, notes with quotes, and print-safe structure", () => {
    const html = buildDoc();
    expect(html).toContain("<h1>Test Article</h1>");
    expect(html).toContain("1 note &middot;");
    expect(html).toContain("example.com");
    expect(html).toContain('id="note-1"');
    expect(html).toContain("&ldquo;target phrase&rdquo;");
    expect(html).toContain("Exported with Oddity");
  });

  it("uses portrait-friendly single-column CSS with no float sidenotes", () => {
    const html = buildDoc();
    expect(html).not.toContain("landscape");
    expect(html).not.toContain("float:right");
    expect(html).not.toContain("float:left");
    expect(html).not.toContain("sidenote");
    expect(html).toContain("@bottom-center");
    expect(html).toContain("counter(page)");
  });

  it("escapes title and subtitle", () => {
    const html = buildExportDocument({
      ...DOC_OPTS,
      title: `A <b>title</b>`,
      subtitle: `"quoted"`,
      bodyHtml: "<p>x</p>",
      notes: [],
    });
    expect(html).toContain("A &lt;b&gt;title&lt;/b&gt;");
    expect(html).toContain("&quot;quoted&quot;");
  });
});
