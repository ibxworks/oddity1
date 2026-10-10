import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// ─── SSRF protection for user-supplied LLM endpoints ─────────────────────────
// Custom base URLs flow into backend fetch() calls that forward the decrypted
// provider key and document content. This module rejects non-public
// destinations: wrong scheme, embedded credentials, blocked hostnames,
// non-public literal IPs, and hostnames that resolve to non-public IPs.
// Callers validate at save time (llm-keys PUT) and at resolve time
// (resolveLlmForRequest), before any fetch happens.

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home"];

const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata.google.internal", // GCP metadata (169.254.169.254)
]);

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const byte = Number(part);
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) return null;
    value = value * 256 + byte;
  }
  return value >>> 0;
}

function inCidr(ip: number, base: number, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ip & mask) >>> 0 === (base & mask) >>> 0;
}

// Non-exhaustive but sufficient: everything that is not global unicast.
function isPublicIpv4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  if (value === null) return false;
  const blocked: Array<[number, number]> = [
    [0x00000000, 8], // 0.0.0.0/8 ("this network")
    [0x0a000000, 8], // 10.0.0.0/8 private
    [0x64400000, 10], // 100.64.0.0/10 CGNAT
    [0x7f000000, 8], // 127.0.0.0/8 loopback
    [0xa9fe0000, 16], // 169.254.0.0/16 link-local (+ cloud metadata)
    [0xac100000, 12], // 172.16.0.0/12 private
    [0xc0000000, 24], // 192.0.0.0/24 IETF reserved
    [0xc0000200, 24], // 192.0.2.0/24 TEST-NET-1
    [0xc0586300, 24], // 192.88.99.0/24 6to4 relay (deprecated)
    [0xc0a80000, 16], // 192.168.0.0/16 private
    [0xc6120000, 15], // 198.18.0.0/15 benchmarking
    [0xc6336400, 24], // 198.51.100.0/24 TEST-NET-2
    [0xcb007100, 24], // 203.0.113.0/24 TEST-NET-3
    [0xe0000000, 4], // 224.0.0.0/4 multicast
    [0xf0000000, 4], // 240.0.0.0/4 reserved
    [0xffffffff, 32], // 255.255.255.255 broadcast
  ];
  return !blocked.some(([base, bits]) => inCidr(value, base, bits));
}

/** Expand an IPv6 literal into 8 hextets, or null when malformed. */
function parseIpv6(ip: string): number[] | null {
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail =
    halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const groups = [...head, ...tail];
  // Embedded IPv4 in the final group (e.g. ::ffff:1.2.3.4).
  const last = groups[groups.length - 1];
  if (last !== undefined && last.includes(".")) {
    const v4 = ipv4ToInt(last);
    if (v4 === null) return null;
    groups.splice(groups.length - 1, 1, ((v4 >>> 16) & 0xffff).toString(16), (v4 & 0xffff).toString(16));
  }
  if (halves.length === 1 && groups.length !== 8) return null;
  if (halves.length === 2) {
    const missing = 8 - groups.length;
    if (missing < 0) return null;
    groups.splice(head.length, 0, ...Array<string>(missing).fill("0"));
  }
  if (groups.length !== 8) return null;
  const nums = groups.map((g) => (/^[0-9a-fA-F]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  if (nums.some((n) => !Number.isInteger(n))) return null;
  return nums as number[];
}

function isPublicIpv6(ip: string): boolean {
  const g = parseIpv6(ip);
  if (!g) return false;
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  if (g.every((n) => n === 0)) return false; // :: unspecified
  if (g7 === 1 && g.slice(0, 7).every((n) => n === 0)) return false; // ::1 loopback
  if ((g0 & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((g0 & 0xfe00) === 0xfc00) return false; // fc00::/7 unique-local
  if ((g0 & 0xff00) === 0xff00) return false; // ff00::/8 multicast
  if (g0 === 0x2001 && (g1 & 0xfe00) === 0) return false; // 2001::/23 IETF special (Teredo etc.)
  if (g0 === 0x2002) return false; // 2002::/16 6to4 (embeds IPv4)
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    // 64:ff9b::/96 NAT64 — check the embedded IPv4 tail.
    const tail = `${(g6 >>> 8) & 0xff}.${g6 & 0xff}.${(g7 >>> 8) & 0xff}.${g7 & 0xff}`;
    return isPublicIpv4(tail);
  }
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    // ::ffff:0:0/96 IPv4-mapped — check the embedded IPv4 tail.
    const tail = `${(g6 >>> 8) & 0xff}.${g6 & 0xff}.${(g7 >>> 8) & 0xff}.${g7 & 0xff}`;
    return isPublicIpv4(tail);
  }
  if (g0 === 0x100) return false; // 100::/64 discard
  if (g0 === 0x2001 && g1 === 0xdb8) return false; // 2001:db8::/32 documentation
  return true;
}

function normalizeHostname(hostname: string): string {
  let host = hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  if (host.endsWith(".")) host = host.slice(0, -1);
  return host;
}

/**
 * Reject custom LLM endpoints that do not point at public HTTPS hosts.
 * Resolves DNS for hostnames and rejects non-public answers. Throws an
 * Error with a user-safe message when the URL is not acceptable.
 */
export async function assertSafeLlmEndpoint(raw: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Base URL must be a valid URL");
  }
  if (url.protocol !== "https:") {
    throw new Error("Base URL must use https");
  }
  if (url.username || url.password) {
    throw new Error("Base URL must not include credentials");
  }

  const host = normalizeHostname(url.hostname);
  if (!host) {
    throw new Error("Base URL must include a host");
  }
  if (
    BLOCKED_HOSTS.has(host) ||
    BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))
  ) {
    throw new Error("Base URL host is not allowed");
  }

  const version = isIP(host);
  if (version === 4) {
    if (!isPublicIpv4(host)) {
      throw new Error("Base URL must point to a public address");
    }
    return;
  }
  if (version === 6 || host.includes(":")) {
    if (!isPublicIpv6(host)) {
      throw new Error("Base URL must point to a public address");
    }
    return;
  }

  let answers: Array<{ address: string }>;
  try {
    answers = await lookup(host, { all: true });
  } catch {
    throw new Error("Base URL host could not be resolved");
  }
  if (answers.length === 0) {
    throw new Error("Base URL host could not be resolved");
  }
  for (const answer of answers) {
    const addr = normalizeHostname(answer.address);
    const addrVersion = isIP(addr);
    const publicAddr =
      addrVersion === 4
        ? isPublicIpv4(addr)
        : addrVersion === 6
          ? isPublicIpv6(addr)
          : false;
    if (!publicAddr) {
      throw new Error("Base URL must point to a public address");
    }
  }
}
