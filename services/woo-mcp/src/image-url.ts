// Guard for image_url (create_product / update_product). WooCommerce downloads the image from the
// URL itself, so a caller-supplied URL must not point into the cluster or the cloud metadata service.
// Checked here before the request is sent (WordPress applies its own safe-fetch rules on top).
import { lookup as dnsLookup, type LookupAddress, type LookupAllOptions } from 'node:dns';
import { BlockList, isIP } from 'node:net';

export class ImageUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageUrlError';
  }
}

const blocked = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96], ['2001:db8::', 32], ['100::', 64],
] as const) blocked.addSubnet(net, bits, 'ipv6');

/** IPv4-mapped IPv6 (::ffff:7f00:1, ::ffff:127.0.0.1) → the IPv4 address it carries. */
function unmap(ip: string): string {
  const m = /^::ffff:(?:0:)?(.+)$/i.exec(ip);
  if (!m) return ip;
  if (isIP(m[1]!) === 4) return m[1]!;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(m[1]!);
  if (!hex) return ip;
  const n = (parseInt(hex[1]!, 16) << 16) | parseInt(hex[2]!, 16);
  return [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');
}

export const isPublicAddress = (address: string): boolean => {
  const ip = unmap(address.replace(/^\[|\]$/g, ''));
  return !blocked.check(ip, isIP(ip) === 6 ? 'ipv6' : 'ipv4');
};

const IMAGE_EXT = /\.(jpe?g|png|gif|webp)$/i;
type Lookup = (host: string, opts: LookupAllOptions) => Promise<LookupAddress[]>;
const lookupAll: Lookup = (host, opts) => new Promise((resolve, reject) => dnsLookup(host, opts, (err, a) => (err ? reject(err) : resolve(a))));

/** https only, no credentials, an image file name, and every resolved address public. Returns the normalized URL. */
export async function validateImageUrl(raw: string, lookup: Lookup = lookupAll): Promise<string> {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { throw new ImageUrlError('image_url is not a valid URL.'); }
  if (u.protocol !== 'https:') throw new ImageUrlError('image_url must be an https:// URL.');
  if (u.username || u.password) throw new ImageUrlError('image_url must not contain credentials.');
  if (!IMAGE_EXT.test(u.pathname)) throw new ImageUrlError('image_url must point to a .jpg, .jpeg, .png, .gif or .webp file.');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (isIP(host)) {
    if (!isPublicAddress(host)) throw new ImageUrlError('image_url must point to a public host.');
    return u.toString();
  }
  let addrs: LookupAddress[];
  try { addrs = await lookup(host, { all: true }); } catch { throw new ImageUrlError(`image_url host ${host} cannot be resolved.`); }
  if (addrs.length === 0 || addrs.some((a) => !isPublicAddress(a.address))) throw new ImageUrlError('image_url must point to a public host.');
  return u.toString();
}
