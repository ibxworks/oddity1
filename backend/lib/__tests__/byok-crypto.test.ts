import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decryptByokKey,
  encryptByokKey,
  isByokCryptoConfigured,
  keyHint,
} from "../byok-crypto.js";

const TEST_KEY = "0123456789abcdef".repeat(4);
const OTHER_KEY = "abcdef0123456789".repeat(4);

describe("byok-crypto", () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.BYOK_ENCRYPTION_KEY;
    process.env.BYOK_ENCRYPTION_KEY = TEST_KEY;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.BYOK_ENCRYPTION_KEY;
    else process.env.BYOK_ENCRYPTION_KEY = saved;
  });

  it("round-trips encryption without leaking plaintext", () => {
    const ciphertext = encryptByokKey("sk-ant-test-123");
    expect(ciphertext).not.toContain("sk-ant-test-123");
    expect(decryptByokKey(ciphertext)).toBe("sk-ant-test-123");
  });

  it("produces unique ciphertexts via random IV", () => {
    expect(encryptByokKey("same")).not.toBe(encryptByokKey("same"));
  });

  it("rejects tampered payloads", () => {
    const ciphertext = encryptByokKey("secret");
    const tampered = `${ciphertext.slice(0, -4)}AAAA`;
    expect(() => decryptByokKey(tampered)).toThrow();
  });

  it("rejects payloads encrypted with a different key", () => {
    const ciphertext = encryptByokKey("secret");
    process.env.BYOK_ENCRYPTION_KEY = OTHER_KEY;
    expect(() => decryptByokKey(ciphertext)).toThrow();
  });

  it("fails closed when unconfigured", () => {
    delete process.env.BYOK_ENCRYPTION_KEY;
    expect(isByokCryptoConfigured()).toBe(false);
    expect(() => encryptByokKey("x")).toThrow();
    expect(() => decryptByokKey("v1.a.b.c")).toThrow();
  });

  it("rejects malformed key material", () => {
    process.env.BYOK_ENCRYPTION_KEY = "too-short";
    expect(isByokCryptoConfigured()).toBe(false);
    process.env.BYOK_ENCRYPTION_KEY = "zz".repeat(32);
    expect(isByokCryptoConfigured()).toBe(false);
  });

  it("hints with the last four characters only", () => {
    expect(keyHint("sk-ant-12345678")).toBe("****5678");
    expect(keyHint("ab")).toBe("****");
    expect(keyHint("sk-ant-12345678")).not.toContain("sk-ant");
  });
});
