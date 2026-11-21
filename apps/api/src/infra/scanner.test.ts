import { createServer, type AddressInfo, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ClamdScanner } from './scanner';
import { contentDisposition, signatureMatches } from './storage';

/** A minimal clamd stand-in: reads INSTREAM chunks and answers FOUND when the payload contains "EICAR". */
function fakeClamd(): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer((s) => {
      let buf = Buffer.alloc(0);
      s.on('data', (d: Buffer) => {
        buf = Buffer.concat([buf, d]);
        if (!buf.subarray(0, 10).equals(Buffer.from('zINSTREAM\0'))) return;
        let off = 10;
        const payload: Buffer[] = [];
        while (off + 4 <= buf.length) {
          const len = buf.readUInt32BE(off);
          if (len === 0) {
            s.end(Buffer.concat(payload).includes('EICAR') ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0');
            return;
          }
          if (off + 4 + len > buf.length) return;
          payload.push(buf.subarray(off + 4, off + 4 + len));
          off += 4 + len;
        }
      });
    });
    server.listen(0, '127.0.0.1', () => { resolve(server); });
  });
}

function chunks(...parts: string[]): AsyncIterable<Uint8Array> {
  const bytes = parts.map((p) => new TextEncoder().encode(p));
  return { [Symbol.asyncIterator]: () => { let i = 0; return { next: () => Promise.resolve(i < bytes.length ? { value: bytes[i++] as Uint8Array, done: false } : { value: undefined, done: true as const }) }; } };
}

let server: Server | undefined;
afterEach(() => { server?.close(); });

describe('ClamdScanner', () => {
  it('speaks INSTREAM and maps OK / FOUND', async () => {
    server = await fakeClamd();
    const scanner = new ClamdScanner('127.0.0.1', (server.address() as AddressInfo).port);
    expect(await scanner.scan(chunks('merhaba ', 'dünya'))).toBe('clean');
    expect(await scanner.scan(chunks('X5O!P%@AP', 'EICAR-STANDARD'))).toBe('infected');
  });

  it('fails when clamd is unreachable (the attachment then stays in quarantine)', async () => {
    await expect(new ClamdScanner('127.0.0.1', 1, 5_000).scan(chunks('x'))).rejects.toThrow();
  });
});

describe('file signatures and download names', () => {
  it('accepts matching signatures only', () => {
    expect(signatureMatches('application/pdf', new TextEncoder().encode('%PDF-1.7'))).toBe(true);
    expect(signatureMatches('application/pdf', new TextEncoder().encode('<html>'))).toBe(false);
    expect(signatureMatches('image/png', Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
    expect(signatureMatches('text/plain', Uint8Array.from([0x61, 0x00, 0x62]))).toBe(false);
    expect(signatureMatches('image/svg+xml', new TextEncoder().encode('<svg'))).toBe(false);
  });

  it('builds an attachment disposition safe for any name', () => {
    expect(contentDisposition('Teklif "son".pdf')).toBe(`attachment; filename="Teklif _son_.pdf"; filename*=UTF-8''Teklif%20%22son%22.pdf`);
    expect(contentDisposition('Şirket özeti.pdf')).toContain(`filename*=UTF-8''%C5%9Eirket%20%C3%B6zeti.pdf`);
  });
});
