export const GDOCS_AUTH_CONFIG_ERROR_PREFIX = "GDocsAuthConfigError:";
export const GDOCS_AUTH_REQUIRED_ERROR_PREFIX = "GDocsAuthRequiredError:";

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function isGDocsAuthConfigMessage(message?: string | null): boolean {
  const normalized = compactWhitespace(message ?? "").toLowerCase();
  if (!normalized) return false;

  return (
    normalized.includes("bad client id") ||
    normalized.includes("invalid client") ||
    normalized.includes("invalid_client") ||
    normalized.includes("deleted_client") ||
    normalized.includes("unknown client") ||
    normalized.includes("client_id") ||
    normalized.includes("client id")
  );
}

export function isGDocsAuthRequiredMessage(message?: string | null): boolean {
  const normalized = compactWhitespace(message ?? "").toLowerCase();
  if (!normalized) return false;

  return (
    normalized.includes("not granted") ||
    normalized.includes("revoked") ||
    normalized.includes("user interaction required") ||
    normalized.includes("user did not approve") ||
    normalized.includes("approval denied") ||
    normalized.includes("access denied") ||
    normalized.includes("authorization denied") ||
    normalized.includes("user canceled") ||
    normalized.includes("user cancelled") ||
    normalized.includes("the user did not approve") ||
    normalized.includes("canceled")
  );
}

export function toGDocsAuthErrorMessage(message?: string | null): string | null {
  const normalized = compactWhitespace(message ?? "");
  if (!normalized) return null;

  if (normalized.startsWith(GDOCS_AUTH_CONFIG_ERROR_PREFIX)) return normalized;
  if (normalized.startsWith(GDOCS_AUTH_REQUIRED_ERROR_PREFIX)) return normalized;
  if (isGDocsAuthConfigMessage(normalized)) {
    return `${GDOCS_AUTH_CONFIG_ERROR_PREFIX}${normalized}`;
  }
  if (isGDocsAuthRequiredMessage(normalized)) {
    return `${GDOCS_AUTH_REQUIRED_ERROR_PREFIX}${normalized}`;
  }
  return null;
}

export function normalizeGDocsAuthError(error: unknown): Error {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : String(error);

  const normalized = toGDocsAuthErrorMessage(raw);
  if (normalized) return new Error(normalized);
  return error instanceof Error ? error : new Error(compactWhitespace(raw));
}

export function isGDocsAuthConfigErrorMessage(message?: string | null): boolean {
  return (message ?? "").startsWith(GDOCS_AUTH_CONFIG_ERROR_PREFIX);
}

export function isGDocsAuthRequiredErrorMessage(message?: string | null): boolean {
  return (message ?? "").startsWith(GDOCS_AUTH_REQUIRED_ERROR_PREFIX);
}
