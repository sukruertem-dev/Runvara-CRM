import { connect } from 'node:net';

// Attachment scanning hook (ADR-0013 §2). With clamd configured, every completed upload is streamed through
// INSTREAM; without it the attachment is explicitly `unscanned` (never silently `clean`).

export type ScanResult = 'clean' | 'infected';

export interface AttachmentScanner {
  scan(body: AsyncIterable<Uint8Array>): Promise<ScanResult>;
}

/** clamd INSTREAM protocol: "zINSTREAM\0", then <uint32 length><chunk>…, then a zero-length chunk. */
export class ClamdScanner implements AttachmentScanner {
  constructor(private readonly host: string, private readonly port: number, private readonly timeoutMs = 30_000) {}

  scan(body: AsyncIterable<Uint8Array>): Promise<ScanResult> {
    return new Promise<ScanResult>((resolve, reject) => {
      const socket = connect({ host: this.host, port: this.port });
      const chunks: Buffer[] = [];
      socket.setTimeout(this.timeoutMs, () => socket.destroy(new Error('clamd timeout')));
      socket.on('data', (d: Buffer) => chunks.push(d));
      socket.on('error', reject);
      socket.on('close', () => {
        const reply = Buffer.concat(chunks).toString('utf8').replace(/\0/g, '').trim();
        if (/\bOK$/.test(reply)) resolve('clean');
        else if (/FOUND$/.test(reply)) resolve('infected');
        else reject(new Error(`clamd: unexpected reply "${reply.slice(0, 200)}"`));
      });
      socket.on('connect', () => {
        void (async () => {
          try {
            socket.write('zINSTREAM\0');
            for await (const chunk of body) {
              const len = Buffer.alloc(4);
              len.writeUInt32BE(chunk.length);
              socket.write(len);
              socket.write(chunk);
            }
            socket.end(Buffer.alloc(4));
          } catch (e) {
            socket.destroy(e as Error);
          }
        })();
      });
    });
  }
}
