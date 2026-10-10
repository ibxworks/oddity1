import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// ─── BYOK key encryption ────────────────────────────────────────────────────
// User provider keys are encrypted with AES-256-GCM before storage. The 32-byte
// key comes from BYOK_ENCRYPTION_KEY (64 hex chars). Every function here fails
// closed: misconfiguration or tampering throws instead of degrading.

export const BYOK_KEY_VERSION = "v1";

function getEncryptionKey(): Buffer {
  const raw = process.env.BYOK_ENCRYPTION_KEY?.trim() ?? "";
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(
      "[byok-crypto] BYOK_ENCRYPTION_KEY must be 32 bytes encoded as 64 hex chars",
    );
  }
  return Buffer.from(raw, "hex");
}

export function isByokCryptoConfigured(): boolean {
  try {
    getEncryptionKey();
    return true;
  } catch {
    return false;
  }
}

export function encryptByokKey(plaintext: string): string {
  if (!plaintext) {
    throw new Error("[byok-crypto] Cannot encrypt an empty key");
  }
  const key = getEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    BYOK_KEY_VERSION,
    iv.toString("base64"),
    ciphertext.toString("base64"),
    tag.toString("base64"),
  ].join(".");
}

export function decryptByokKey(payload: string): string {
  const key = getEncryptionKey();
  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== BYOK_KEY_VERSION) {
    throw new Error("[byok-crypto] Unrecognized key payload");
  }
  const [, ivB64, ctB64, tagB64] = parts as [string, string, string, string];
  const tag = Buffer.from(tagB64, "base64");
  // Require the full 16-byte tag: without authTagLength, truncated tags are
  // accepted and authentication degrades as low as 32 bits.
  if (tag.length !== 16) {
    throw new Error("[byok-crypto] Failed to decrypt key");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"), {
      authTagLength: 16,
    });
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ctB64, "base64")),
      decipher.final(),
    ]);
    return plaintext.toString("utf8");
  } catch {
    // Deliberately vague: authentication failure, wrong key, or corruption.
    throw new Error("[byok-crypto] Failed to decrypt key");
  }
}

/** Last-4 hint for UIs. Never returns the full key. */
export function keyHint(apiKey: string): string {
  return apiKey.length <= 4 ? "****" : `****${apiKey.slice(-4)}`;
}
