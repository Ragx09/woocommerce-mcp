// SSRF guard for admin-supplied upstream URLs (UI-05, T-06, docs/MCP_DESIGN.md §12).
// An admin can make the gateway send requests anywhere, so "anywhere" is limited:
// - http(s) only, no user:password@ in the URL, at most 2048 characters;
// - every address the host resolves to must be public: loopback, private (incl. the cluster's pod and
//   service ranges), link-local (cloud metadata 169.254.169.254), CGNAT, multicast, reserved and the
//   IPv6 equivalents are refused;
// - internal servers are reachable only when their host name is on an operator allowlist
//   (UPSTREAM_ALLOWED_HOSTS, set by the Helm chart to the bundled MCP Services). The allowlist names
//   hosts, not networks: `postgres.platform.svc.cluster.local` stays blocked although it is internal.
//   Even an allowlisted host may not resolve to link-local/metadata addresses.
// Checked twice: when a URL is saved (validateUpstreamUrl, a clear 400 for the admin) and on every
// connection (guardedLookup inside the pool's HTTP agent, plus a literal-IP check), so a host that
// later re-resolves to an internal address (DNS rebinding) or a row written around the API is refused.
import { lookup as dnsLookup, type LookupAddress, type LookupAllOptions } from 'node:dns';
import { BlockList, isIP } from 'node:net';

export class SsrfError extends Error {
  readonly code = 'ssrf_blocked';
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

export interface SsrfPolicy {
  /** Lower-case host names (or IP literals) that may resolve to internal addresses. */
  allowedHosts: ReadonlySet<string>;
  /** Anchored patterns for internal hosts that are created at runtime (BON-13: each store's woo-mcp). */
  allowedHostPatterns?: readonly RegExp[];
}

export function ssrfPolicy(allowedHosts: Iterable<string> = [], allowedHostPatterns: readonly RegExp[] = []): SsrfPolicy {
  return { allowedHosts: new Set([...allowedHosts].map((h) => h.trim().toLowerCase().replace(/\.$/, '')).filter(Boolean)), allowedHostPatterns };
}

/** A created store's woo-mcp Service (namespace store-<slug>, D-026). Nothing else in those namespaces is allowed. */
export const STORE_WOO_MCP_HOST = /^woo-mcp\.store-[a-z][a-z0-9-]{1,14}[a-z0-9]\.svc\.cluster\.local$/;

/** A hosted MCP server's Service (namespace hosted-<slug>, BON-10 / D-029). */
export const HOSTED_SERVER_HOST = /^server\.hosted-[a-z][a-z0-9-]{1,14}[a-z0-9]\.svc\.cluster\.local$/;

const hostAllowed = (host: string, policy: SsrfPolicy) =>
  policy.allowedHosts.has(host) || (policy.allowedHostPatterns ?? []).some((re) => re.test(host));

const always = new BlockList(); // never reachable, allowlisted or not
always.addSubnet('169.254.0.0', 16, 'ipv4'); // link-local incl. cloud metadata
always.addSubnet('fe80::', 10, 'ipv6');
always.addAddress('fd00:ec2::254', 'ipv6'); // AWS IMDS over IPv6

const internal = new BlockList(); // reachable only through an allowlisted host name
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) internal.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['ff00::', 8], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['2001:db8::', 32], ['100::', 64],
] as const) internal.addSubnet(net, bits, 'ipv6');

/** IPv4-mapped/compatible IPv6 (::ffff:7f00:1, ::ffff:127.0.0.1) → the IPv4 address it carries. */
function unmap(ip: string): string {
  const m = /^::ffff:(?:0:)?(.+)$/i.exec(ip);
  if (!m) return ip;
  const rest = m[1]!;
  if (isIP(rest) === 4) return rest;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(rest);
  if (!hex) return ip;
  const n = (parseInt(hex[1]!, 16) << 16) | parseInt(hex[2]!, 16);
  return [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');
}

/** Why an address may not be used: 'metadata/link-local', 'internal', or null when it is public. */
export function addressClass(address: string): 'metadata/link-local' | 'internal' | null {
  const ip = unmap(address.replace(/^\[|\]$/g, ''));
  const type = isIP(ip) === 6 ? 'ipv6' : 'ipv4';
  if (always.check(ip, type)) return 'metadata/link-local';
  if (internal.check(ip, type)) return 'internal';
  return null;
}

function checkAddress(host: string, address: string, policy: SsrfPolicy): void {
  const cls = addressClass(address);
  if (!cls) return;
  if (cls === 'internal' && hostAllowed(host, policy)) return;
  throw new SsrfError(cls === 'internal'
    ? `${host} resolves to an internal address; only allowlisted internal hosts may be used`
    : `${host} resolves to a link-local/metadata address`);
}

/** Syntax rules; returns the parsed URL. Host names come back lower-case without a trailing dot. */
export function parseUpstreamUrl(raw: string): URL {
  if (raw.length > 2048) throw new SsrfError('URL is longer than 2048 characters');
  let u: URL;
  try { u = new URL(raw); } catch { throw new SsrfError('not a valid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new SsrfError('only http:// and https:// URLs are allowed');
  if (u.username || u.password) throw new SsrfError('credentials in the URL are not allowed; use the credential field');
  if (!u.hostname) throw new SsrfError('URL has no host');
  return u;
}

export const hostOf = (u: URL) => u.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');

type Lookup = (host: string, opts: LookupAllOptions) => Promise<LookupAddress[]>;
const lookupAll: Lookup = (host, opts) => new Promise((resolve, reject) =>
  dnsLookup(host, opts, (err, addrs) => (err ? reject(err) : resolve(addrs))));

/** Full check for an API request: syntax + every resolved address. Returns the normalized URL string. */
export async function validateUpstreamUrl(raw: string, policy: SsrfPolicy, lookup: Lookup = lookupAll): Promise<string> {
  const u = parseUpstreamUrl(raw.trim());
  const host = hostOf(u);
  if (isIP(host)) {
    checkAddress(host, host, policy);
    return u.toString();
  }
  let addrs: LookupAddress[];
  try { addrs = await lookup(host, { all: true }); } catch { throw new SsrfError(`cannot resolve ${host}`); }
  if (addrs.length === 0) throw new SsrfError(`cannot resolve ${host}`);
  for (const a of addrs) checkAddress(host, a.address, policy);
  return u.toString();
}

/** Connect-time check for a literal-IP URL (Node skips `lookup` for IP hosts). */
export function checkLiteralHost(url: string | URL, policy: SsrfPolicy): void {
  const host = hostOf(new URL(url));
  if (isIP(host)) checkAddress(host, host, policy);
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * A `lookup` for net/tls connect (undici `connect.lookup`): resolves as usual, then refuses the
 * connection if any address is not allowed. The address checked is the one connected to.
 */
export function guardedLookup(policy: SsrfPolicy, base: typeof dnsLookup = dnsLookup) {
  return (hostname: string, options: { all?: boolean; family?: number } | number, cb: LookupCallback): void => {
    const opts = typeof options === 'number' ? { family: options } : options;
    base(hostname, { ...opts, all: true }, (err, addrs) => {
      if (err) return cb(err, '');
      try {
        const host = hostname.toLowerCase().replace(/\.$/, '');
        for (const a of addrs) checkAddress(host, a.address, policy);
      } catch (e) {
        return cb(e as NodeJS.ErrnoException, '');
      }
      if (opts.all) return cb(null, addrs);
      const first = addrs[0]!;
      cb(null, first.address, first.family);
    });
  };
}
