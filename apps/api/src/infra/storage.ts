import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { ApiEnv } from '@flexa/config';

// Object storage for attachments (ADR-0013 §2): S3-compatible (MinIO in development and tests). Objects are
// written and read only through short-lived signed URLs; the API itself never streams file bodies.

export interface ObjectStorage {
  /** Signed PUT; the uploader must send exactly `content-type` and `content-disposition` (both are signed). */
  signedPut(key: string, mime: string, size: number, fileName: string, ttlSeconds: number): Promise<string>;
  signedGet(key: string, fileName: string, mime: string, ttlSeconds: number): Promise<string>;
  head(key: string): Promise<{ size: number } | null>;
  /** First `n` bytes of the object (file signature check). */
  firstBytes(key: string, n: number): Promise<Uint8Array>;
  /** Whole object as a stream for the scanner. */
  stream(key: string): Promise<AsyncIterable<Uint8Array>>;
  remove(key: string): Promise<void>;
}

/** RFC 6266 attachment disposition with an ASCII fallback and the UTF-8 name. */
export function contentDisposition(fileName: string): string {
  const ascii = fileName.normalize('NFKD').replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export class S3Storage implements ObjectStorage {
  private readonly client: S3Client;
  /** Signs URLs for the browser-facing endpoint when it differs from the internal one. */
  private readonly signer: S3Client;

  constructor(private readonly bucket: string, env: ApiEnv) {
    const base = {
      region: env.S3_REGION,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      ...(env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY ? { credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY } } : {}),
    };
    this.client = new S3Client({ ...base, ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}) });
    const publicEndpoint = env.S3_PUBLIC_ENDPOINT ?? env.S3_ENDPOINT;
    this.signer = new S3Client({ ...base, ...(publicEndpoint ? { endpoint: publicEndpoint } : {}) });
  }

  signedPut(key: string, mime: string, size: number, fileName: string, ttlSeconds: number): Promise<string> {
    // The disposition is stored with the object as well, so even a direct object URL downloads instead of rendering.
    return getSignedUrl(this.signer, new PutObjectCommand({
      Bucket: this.bucket, Key: key, ContentType: mime, ContentLength: size, ContentDisposition: contentDisposition(fileName),
    }), { expiresIn: ttlSeconds, signableHeaders: new Set(['content-type', 'content-disposition']) });
  }

  signedGet(key: string, fileName: string, mime: string, ttlSeconds: number): Promise<string> {
    return getSignedUrl(this.signer, new GetObjectCommand({
      Bucket: this.bucket, Key: key, ResponseContentDisposition: contentDisposition(fileName), ResponseContentType: mime,
    }), { expiresIn: ttlSeconds });
  }

  async head(key: string): Promise<{ size: number } | null> {
    try {
      const r = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: r.ContentLength ?? 0 };
    } catch (e) {
      const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404) return null;
      throw e;
    }
  }

  async firstBytes(key: string, n: number): Promise<Uint8Array> {
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: `bytes=0-${n - 1}` }));
    return r.Body ? await r.Body.transformToByteArray() : new Uint8Array();
  }

  async stream(key: string): Promise<AsyncIterable<Uint8Array>> {
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!r.Body) return (async function* empty() {})();
    return r.Body as AsyncIterable<Uint8Array>;
  }

  async remove(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

/** Storage built from the environment, or null when no bucket is configured. */
export function storageFromEnv(env: ApiEnv): ObjectStorage | null {
  return env.S3_BUCKET ? new S3Storage(env.S3_BUCKET, env) : null;
}

// ---------------------------------------------------------------------------------------------- signatures

const startsWith = (b: Uint8Array, sig: number[], offset = 0) => sig.every((v, i) => b[offset + i] === v);
const ZIP = [0x50, 0x4b, 0x03, 0x04];

/** Does the file start with the signature its declared MIME type promises? Text types must not contain NUL. */
export function signatureMatches(mime: string, head: Uint8Array): boolean {
  switch (mime) {
    case 'application/pdf': return startsWith(head, [0x25, 0x50, 0x44, 0x46, 0x2d]);
    case 'image/png': return startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/jpeg': return startsWith(head, [0xff, 0xd8, 0xff]);
    case 'image/gif': return startsWith(head, [0x47, 0x49, 0x46, 0x38]);
    case 'image/webp': return startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8);
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
    case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
      return startsWith(head, ZIP);
    case 'text/plain':
    case 'text/csv':
      return head.length > 0 && !head.includes(0);
    default:
      return false;
  }
}
