import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { ProblemError } from './problem';

// ADR-0013: outbound URLs supplied by tenants (OIDC issuer now; webhooks and BYO AI endpoints later)
// must not reach private, loopback, link-local (cloud metadata) or other non-public networks.
const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(net, prefix, 'ipv4');
// IPv4-mapped IPv6 (::ffff:a.b.c.d) is NOT added as a subnet: Node's BlockList would then match every
// IPv4 address. Mapped addresses are unwrapped and checked against the IPv4 rules instead.
for (const [net, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96]] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

const MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

export function isPublicAddress(address: string): boolean {
  const mapped = MAPPED.exec(address);
  if (mapped?.[1]) return isPublicAddress(mapped[1]);
  const family = isIP(address);
  if (family === 0) return false;
  if (family === 6 && /^::ffff:/i.test(address)) return false; // hex-form mapped address: refuse rather than guess
  return !blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/** Throws unless the URL is https and every resolved address is public.
 *  `allowInsecureLocalhost` (dev/test only, rejected in production by env validation) admits http://localhost. */
export async function assertSafeOutboundUrl(raw: string, options: { allowInsecureLocalhost: boolean }): Promise<URL> {
  return (await resolveSafeOutbound(raw, options)).url;
}

/** Validates the URL and returns the vetted address the connection must use (DNS-rebinding guard: the
 *  request is pinned to this address instead of resolving the name again). */
export async function resolveSafeOutbound(raw: string, options: { allowInsecureLocalhost: boolean }): Promise<{ url: URL; address: string; family: 4 | 6 }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProblemError('VALIDATION_FAILED', 'invalid URL');
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (options.allowInsecureLocalhost && local && (url.protocol === 'http:' || url.protocol === 'https:')) return { url, address: '127.0.0.1', family: 4 };
  if (url.protocol !== 'https:') throw new ProblemError('VALIDATION_FAILED', 'only https URLs are allowed');
  if (url.username || url.password) throw new ProblemError('VALIDATION_FAILED', 'credentials in URL are not allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  const first = addresses[0];
  if (first === undefined || !addresses.every(isPublicAddress)) {
    throw new ProblemError('VALIDATION_FAILED', 'URL must resolve to public addresses only');
  }
  const mapped = MAPPED.exec(first)?.[1];
  const address = mapped ?? first;
  return { url, address, family: isIP(address) === 6 ? 6 : 4 };
}

export interface OutboundResponse { status: number; body: string }

/** POST with the ADR-0013 rules: pinned to the vetted address, no redirects (3xx is a failure for the
 *  caller to judge), connect 3 s / total 10 s, at most 64 KB of the response body read. */
export async function safePost(raw: string, body: string | Buffer, headers: Record<string, string>, options: { allowInsecureLocalhost: boolean; timeoutMs?: number }): Promise<OutboundResponse> {
  const { url, address, family } = await resolveSafeOutbound(raw, options);
  const mod = url.protocol === 'https:' ? await import('node:https') : await import('node:http');
  const total = options.timeoutMs ?? 10_000;
  return new Promise<OutboundResponse>((resolve, reject) => {
    const req = mod.request(url, {
      method: 'POST',
      headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) },
      // Pin the connection to the vetted address; the Host header and TLS SNI still carry the name.
      lookup: (_host: string, _opts: unknown, cb: (err: Error | null, address: string, family: number) => void) => { cb(null, address, family); },
      timeout: 3_000,
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        if (size < 65_536) chunks.push(c.subarray(0, 65_536 - size));
        size += c.length;
        if (size >= 65_536) res.destroy();
      });
      const done = () => { resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }); };
      res.on('end', done);
      res.on('close', done);
      res.on('error', reject);
    });
    const timer = setTimeout(() => { req.destroy(new Error(`timed out after ${total} ms`)); }, total);
    req.on('timeout', () => { req.destroy(new Error('connect timeout')); });
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.on('close', () => { clearTimeout(timer); });
    req.end(body);
  });
}
