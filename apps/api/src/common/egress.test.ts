import { describe, expect, it } from 'vitest';
import { assertSafeOutboundUrl, isPublicAddress } from './egress';

describe('egress guard (SSRF)', () => {
  it('classifies addresses', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '0.0.0.0']) {
      expect(isPublicAddress(a), a).toBe(false);
    }
    for (const a of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) expect(isPublicAddress(a), a).toBe(true);
    expect(isPublicAddress('not-an-ip')).toBe(false);
  });

  it('rejects http, private literals, metadata endpoint and embedded credentials', async () => {
    const opts = { allowInsecureLocalhost: false };
    await expect(assertSafeOutboundUrl('http://example.com', opts)).rejects.toThrow(/https/);
    await expect(assertSafeOutboundUrl('https://169.254.169.254/latest/meta-data', opts)).rejects.toThrow(/public/);
    await expect(assertSafeOutboundUrl('https://[::1]/', opts)).rejects.toThrow(/public/);
    await expect(assertSafeOutboundUrl('https://localhost:8443', opts)).rejects.toThrow(/public/);
    await expect(assertSafeOutboundUrl('https://user:pw@8.8.8.8/', opts)).rejects.toThrow(/credentials/);
    await expect(assertSafeOutboundUrl('nope', opts)).rejects.toThrow(/invalid/);
    await expect(assertSafeOutboundUrl('https://8.8.8.8/', opts)).resolves.toBeInstanceOf(URL);
  });

  it('admits http://localhost only when explicitly allowed (dev/test)', async () => {
    await expect(assertSafeOutboundUrl('http://localhost:9000', { allowInsecureLocalhost: true })).resolves.toBeInstanceOf(URL);
    await expect(assertSafeOutboundUrl('http://localhost:9000', { allowInsecureLocalhost: false })).rejects.toThrow();
  });
});
