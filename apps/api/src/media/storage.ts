import { Injectable, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Configuration } from '../configuration.js';

@Injectable()
export class MediaStorage implements OnModuleDestroy {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly configured: boolean;

  constructor(configuration: Configuration) {
    const storage = configuration.values.storage;
    this.bucket = storage.bucket;
    this.configured = Boolean(storage.accessKeyId && storage.secretAccessKey);
    this.client = new S3Client({
      endpoint: storage.endpoint,
      region: storage.region,
      forcePathStyle: storage.forcePathStyle,
      credentials: { accessKeyId: storage.accessKeyId, secretAccessKey: storage.secretAccessKey },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      maxAttempts: 2,
      requestHandler: { connectionTimeout: 5000, requestTimeout: 15000 }
    });
  }

  private check(): void {
    if (!this.configured)
      throw new ServiceUnavailableException('Object storage is not initialized.');
  }

  async signUpload(
    key: string,
    contentType: string,
    bytes: number,
    expiresSeconds: number
  ): Promise<string> {
    this.check();
    return getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
        ContentLength: bytes
      }),
      {
        expiresIn: expiresSeconds,
        signableHeaders: new Set(['content-type', 'content-length'])
      }
    );
  }

  async head(key: string): Promise<{ bytes: number; contentType: string }> {
    this.check();
    const result = await this.client.send(
      new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      { abortSignal: AbortSignal.timeout(20000) }
    );
    return { bytes: result.ContentLength ?? -1, contentType: result.ContentType ?? '' };
  }

  async read(key: string, maxBytes: number): Promise<Buffer> {
    this.check();
    const signal = AbortSignal.timeout(20000);
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      abortSignal: signal
    });
    const body = result.Body;
    if (!body) throw new Error('Stored object has no body.');
    const destroy = (error?: Error) => {
      if ('destroy' in body && typeof body.destroy === 'function') body.destroy(error);
    };
    const abort = () => destroy(new Error('Stored object read timed out.'));
    signal.addEventListener('abort', abort, { once: true });
    if (result.ContentLength !== undefined && result.ContentLength > maxBytes) {
      destroy();
      signal.removeEventListener('abort', abort);
      throw new Error('Stored object exceeds the read limit.');
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    try {
      signal.throwIfAborted();
      for await (const chunk of body as AsyncIterable<Uint8Array>) {
        signal.throwIfAborted();
        bytes += chunk.byteLength;
        if (bytes > maxBytes) throw new Error('Stored object exceeds the read limit.');
        chunks.push(Buffer.from(chunk));
      }
      signal.throwIfAborted();
    } finally {
      signal.removeEventListener('abort', abort);
      destroy();
    }
    return Buffer.concat(chunks, bytes);
  }

  async write(key: string, body: Buffer, contentType: string): Promise<void> {
    this.check();
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentLength: body.length
      }),
      { abortSignal: AbortSignal.timeout(20000) }
    );
  }

  async remove(key: string): Promise<void> {
    this.check();
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }), {
      abortSignal: AbortSignal.timeout(20000)
    });
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }
}
