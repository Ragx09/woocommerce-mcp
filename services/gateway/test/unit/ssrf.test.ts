// TC-UNIT-04 (UI-05, T-06): SSRF guard for upstream URLs — syntax, address classes, allowlist, and the
// connect-time lookup used by the pool's HTTP agent.
import type { LookupAddress } from 'node:dns';
import { describe, expect, it } from 'vitest';
import { addressClass, guardedLookup, parseUpstreamUrl, SsrfError, ssrfPolicy, validateUpstreamUrl, checkLiteralHost } from '../../src/upstreams/ssrf.js';

const dns = (table: Record<string, string[]>) => async (host: string): Promise<LookupAddress[]> => {
  const a = table[host];
  if (!a) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
  return a.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
};
const TABLE = {
  'mcp.example.com': ['93.184.215.14'],
  'woo-mcp.store.svc.cluster.local': ['10.43.12.7'],
  'postgres.platform.svc.cluster.local': ['10.43.99.1'],
  'metadata.google.internal': ['169.254.169.254'],
  'rebind.example.com': ['93.184.215.14', '127.0.0.1'], // one bad answer is enough
  'evil-allow.example.com': ['169.254.169.254'],
  'v6.example.com': ['2606:2800:220:1::1'],
};
const policy = ssrfPolicy(['woo-mcp.store.svc.cluster.local', 'evil-allow.example.com', 'WOO-MCP.STORE.SVC.CLUSTER.LOCAL.']);
const validate = (url: string) => validateUpstreamUrl(url, policy, dns(TABLE)).then(() => 'ok', (e: Error) => (e instanceof SsrfError ? 'blocked' : `other: ${e.message}`));

describe('TC-UNIT-04 SSRF guard', () => {
  it('address classes: public vs internal vs metadata/link-local, incl. IPv6 and mapped forms', () => {
    for (const ip of ['93.184.215.14', '8.8.8.8', '2606:2800:220:1::1']) expect(addressClass(ip), ip).toBeNull();
    for (const ip of ['127.0.0.1', '10.43.0.10', '10.42.1.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '0.0.0.0',
      '224.0.0.1', '255.255.255.255', '::1', '::', 'fd12:3456::1', 'fc00::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a2b:c0d', '64:ff9b::7f00:1'])
      expect(addressClass(ip), ip).toBe('internal');
    for (const ip of ['169.254.169.254', '169.254.0.1', 'fe80::1', 'fd00:ec2::254', '::ffff:169.254.169.254', '::ffff:a9fe:a9fe'])
      expect(addressClass(ip), ip).toBe('metadata/link-local');
    expect(addressClass('172.32.0.1')).toBeNull(); // just outside 172.16/12
  });

  it('URL syntax: http(s) only, no credentials, length cap', () => {
    for (const bad of ['ftp://x/mcp', 'file:///etc/passwd', 'gopher://x', 'javascript:alert(1)', 'not a url', 'http://user:pw@mcp.example.com/mcp',
      `https://mcp.example.com/${'a'.repeat(2050)}`]) expect(() => parseUpstreamUrl(bad), bad).toThrow(SsrfError);
    expect(parseUpstreamUrl('https://MCP.Example.com/mcp').hostname).toBe('mcp.example.com');
  });

  it('TC-SEC-01 set: metadata, cluster DB, loopback and private literals are refused; public and allowlisted pass', async () => {
    expect(await validate('https://mcp.example.com/mcp')).toBe('ok');
    expect(await validate('https://v6.example.com/mcp')).toBe('ok');
    expect(await validate('http://woo-mcp.store.svc.cluster.local/mcp')).toBe('ok'); // allowlisted internal Service
    for (const bad of [
      'http://169.254.169.254/latest/meta-data/', 'http://metadata.google.internal/computeMetadata/v1/',
      'http://postgres.platform.svc.cluster.local:5432', 'http://127.0.0.1:8080/mcp', 'http://localhost/mcp',
      'http://[::1]/mcp', 'http://[::ffff:127.0.0.1]/mcp', 'http://2130706433/mcp', 'http://0x7f.1/mcp', 'http://10.43.0.1/mcp',
      'http://rebind.example.com/mcp', 'http://evil-allow.example.com/mcp', 'http://unknown.invalid/mcp',
    ]) expect(await validate(bad), bad).toBe('blocked');
  });

  it('allowlist matches host names case-insensitively, never networks', async () => {
    expect(policy.allowedHosts.has('woo-mcp.store.svc.cluster.local')).toBe(true);
    expect(await validate('http://WOO-MCP.store.svc.cluster.local./mcp')).toBe('ok');
    expect(await validate('http://woo-mcp.store.svc.cluster.local.evil.com/mcp')).toBe('blocked'); // unknown host
  });

  it('connect time: lookup refuses internal answers (DNS rebinding), literal IPs are checked separately', async () => {
    const base = ((host: string, _o: unknown, cb: (e: Error | null, a: LookupAddress[]) => void) =>
      cb(null, host === 'flip.example.com' ? [{ address: '10.0.0.5', family: 4 }] : [{ address: '93.184.215.14', family: 4 }])) as never;
    const lookup = guardedLookup(ssrfPolicy([]), base);
    const run = (host: string, all = false) => new Promise<unknown>((resolve, reject) =>
      lookup(host, { all }, (err, address) => (err ? reject(err) : resolve(address))));
    expect(await run('mcp.example.com')).toBe('93.184.215.14');
    expect(await run('mcp.example.com', true)).toEqual([{ address: '93.184.215.14', family: 4 }]);
    await expect(run('flip.example.com')).rejects.toBeInstanceOf(SsrfError);
    expect(() => checkLiteralHost('http://127.0.0.1:9/mcp', ssrfPolicy([]))).toThrow(SsrfError);
    expect(() => checkLiteralHost('http://127.0.0.1:9/mcp', ssrfPolicy(['127.0.0.1']))).not.toThrow();
    expect(() => checkLiteralHost('http://169.254.169.254/', ssrfPolicy(['169.254.169.254']))).toThrow(SsrfError);
    expect(() => checkLiteralHost('https://mcp.example.com/mcp', ssrfPolicy([]))).not.toThrow(); // names go through lookup
  });
});
