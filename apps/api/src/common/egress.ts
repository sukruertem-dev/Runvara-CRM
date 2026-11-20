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
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProblemError('VALIDATION_FAILED', 'invalid URL');
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (options.allowInsecureLocalhost && local && (url.protocol === 'http:' || url.protocol === 'https:')) return url;
  if (url.protocol !== 'https:') throw new ProblemError('VALIDATION_FAILED', 'only https URLs are allowed');
  if (url.username || url.password) throw new ProblemError('VALIDATION_FAILED', 'credentials in URL are not allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (addresses.length === 0 || !addresses.every(isPublicAddress)) {
    throw new ProblemError('VALIDATION_FAILED', 'URL must resolve to public addresses only');
  }
  return url;
}
