import { beforeEach, describe, expect, it, vi } from "vitest";

const mockLookup = vi.fn();

vi.mock("node:dns/promises", () => ({
  lookup: (...args: unknown[]) => mockLookup(...args),
}));

import { assertSafeLlmEndpoint } from "../ssrf.js";

describe("assertSafeLlmEndpoint", () => {
  beforeEach(() => {
    mockLookup.mockReset();
    mockLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  });

  it("accepts a public HTTPS host", async () => {
    await expect(
      assertSafeLlmEndpoint("https://proxy.example.com/v1"),
    ).resolves.toBeUndefined();
    expect(mockLookup).toHaveBeenCalledWith("proxy.example.com", { all: true });
  });

  it("accepts a public literal IPv4 without DNS", async () => {
    await expect(
      assertSafeLlmEndpoint("https://93.184.216.34/v1"),
    ).resolves.toBeUndefined();
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it.each([
    "http://proxy.example.com/v1",
    "ftp://proxy.example.com/v1",
    "not-a-url",
    "",
  ])("rejects non-HTTPS URLs: %s", async (raw) => {
    await expect(assertSafeLlmEndpoint(raw)).rejects.toThrow();
  });

  it("rejects embedded credentials", async () => {
    await expect(
      assertSafeLlmEndpoint("https://user:pass@proxy.example.com/v1"),
    ).rejects.toThrow("credentials");
  });

  it.each([
    "https://localhost/v1",
    "https://localhost:8443/v1",
    "https://foo.localhost/v1",
    "https://printer.local/v1",
    "https://db.internal/v1",
    "https://metadata.google.internal/v1",
  ])("rejects blocked hostnames: %s", async (raw) => {
    await expect(assertSafeLlmEndpoint(raw)).rejects.toThrow();
  });

  it.each([
    "https://127.0.0.1/v1",
    "https://127.1/v1",
    "https://10.0.0.5/v1",
    "https://172.16.4.4/v1",
    "https://172.31.255.1/v1",
    "https://192.168.1.1/v1",
    "https://169.254.169.254/latest/meta-data",
    "https://0.0.0.0/v1",
    "https://224.0.0.1/v1",
    "https://255.255.255.255/v1",
    "https://100.64.0.1/v1",
    "https://192.0.2.1/v1",
  ])("rejects non-public IPv4 literals: %s", async (raw) => {
    await expect(assertSafeLlmEndpoint(raw)).rejects.toThrow("public");
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it.each([
    "https://[::1]/v1",
    "https://[::]/v1",
    "https://[fe80::1]/v1",
    "https://[fc00::1]/v1",
    "https://[fd00::1]/v1",
    "https://[ff02::1]/v1",
    "https://[::ffff:127.0.0.1]/v1",
    "https://[::ffff:10.0.0.1]/v1",
    "https://[2001::1]/v1",
    "https://[2002:c000:200::]/v1",
  ])("rejects non-public IPv6 literals: %s", async (raw) => {
    await expect(assertSafeLlmEndpoint(raw)).rejects.toThrow("public");
  });

  it("accepts a public IPv6 literal", async () => {
    await expect(
      assertSafeLlmEndpoint("https://[2606:2800:220:1:248:1893:25c8:1946]/v1"),
    ).resolves.toBeUndefined();
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("rejects hostnames that resolve to private addresses", async () => {
    mockLookup.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "10.1.2.3", family: 4 },
    ]);
    await expect(
      assertSafeLlmEndpoint("https://proxy.example.com/v1"),
    ).rejects.toThrow("public");
  });

  it("rejects hostnames that resolve to IPv6 link-local", async () => {
    mockLookup.mockResolvedValue([{ address: "fe80::1", family: 6 }]);
    await expect(
      assertSafeLlmEndpoint("https://proxy.example.com/v1"),
    ).rejects.toThrow("public");
  });

  it("rejects unresolvable hostnames", async () => {
    mockLookup.mockRejectedValue(new Error("ENOTFOUND"));
    await expect(
      assertSafeLlmEndpoint("https://proxy.example.com/v1"),
    ).rejects.toThrow("resolved");
  });
});
