/**
 * Compute SHA-256 hash of text using Web Crypto API.
 * Falls back to a simple hash on insecure contexts (e.g. blob:null from file:// PDFs)
 * where crypto.subtle is unavailable.
 * Returns "sha256:<hex>" format.
 */
export async function sha256(text: string): Promise<string> {
  if (crypto?.subtle) {
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
    return `sha256:${hex}`;
  }

  // Fallback: simple FNV-1a-inspired hash for insecure contexts
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `hash:${(h >>> 0).toString(16).padStart(8, '0')}`;
}
