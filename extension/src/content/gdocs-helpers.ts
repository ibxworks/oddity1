import {
  isGDocsAuthConfigErrorMessage,
  isGDocsAuthRequiredErrorMessage,
} from "../shared/gdocs-auth.js";

export type GDocsResolvedTextSource = "api" | "export" | "fallback" | "empty";

export type GDocsResolvedText = {
  text: string;
  source: GDocsResolvedTextSource;
  error?: string;
};

type ResolveGDocsDocumentTextOptions = {
  docId: string;
  readApiText: () => Promise<{ text?: string; error?: string }>;
  readExportText: (docId: string) => Promise<string | null>;
  fallbackTexts?: Array<string | null | undefined>;
};

function normalizeTextCandidate(value?: string | null): string {
  return value?.trim() ?? "";
}

export async function resolveGDocsDocumentText({
  docId,
  readApiText,
  readExportText,
  fallbackTexts = [],
}: ResolveGDocsDocumentTextOptions): Promise<GDocsResolvedText> {
  const apiResult = await readApiText();
  const apiText = normalizeTextCandidate(apiResult.text);
  if (apiText) {
    return { text: apiText, source: "api", error: apiResult.error };
  }

  const exportText = docId
    ? normalizeTextCandidate(await readExportText(docId))
    : "";
  if (exportText) {
    return { text: exportText, source: "export", error: apiResult.error };
  }

  for (const candidate of fallbackTexts) {
    const fallbackText = normalizeTextCandidate(candidate);
    if (fallbackText) {
      return { text: fallbackText, source: "fallback", error: apiResult.error };
    }
  }

  return { text: "", source: "empty", error: apiResult.error };
}

export function getGDocsEditInlineErrorMessage(error?: string): string {
  if (isGDocsAuthConfigErrorMessage(error)) {
    return "Google Docs editing is unavailable right now because the Google OAuth client is misconfigured.";
  }
  if (isGDocsAuthRequiredErrorMessage(error)) {
    return "Google Docs needs permission before it can edit this document. Try again and approve access.";
  }
  return "Couldn't locate the text to edit — the document may have changed. Try again.";
}

export function isGDocsEditAuthError(error?: string): boolean {
  return (
    isGDocsAuthConfigErrorMessage(error) ||
    isGDocsAuthRequiredErrorMessage(error)
  );
}
