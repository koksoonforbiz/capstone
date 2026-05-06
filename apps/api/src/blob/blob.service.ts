import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  type CompletedPart,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
export interface PutBlobOptions {
  key: string;
  body: Buffer | string;
  contentType: string;
}

export interface PresignedUrlOptions {
  key: string;
  contentType?: string;
  expiresIn?: number;
}

@Injectable()
export class BlobService implements OnModuleInit {
  private readonly logger = new Logger(BlobService.name);
  private readonly client: S3Client;
  private readonly presignClient: S3Client;
  private readonly bucket: string;
  private readonly publicEndpoint: string | undefined;
  private readonly internalEndpoint: string;

  constructor(private readonly config: ConfigService) {
    this.internalEndpoint = this.config.getOrThrow<string>('BLOB_STORAGE_ENDPOINT');
    this.bucket = this.config.getOrThrow<string>('BLOB_STORAGE_BUCKET');
    this.publicEndpoint = this.config.get<string>('BLOB_STORAGE_PUBLIC_ENDPOINT');

    const region = this.config.get<string>('BLOB_STORAGE_REGION', 'us-east-1');
    const credentials = {
      accessKeyId: this.config.getOrThrow<string>('BLOB_STORAGE_ACCESS_KEY'),
      secretAccessKey: this.config.getOrThrow<string>('BLOB_STORAGE_SECRET_KEY'),
    };

    // AWS SDK v3 (≥ 3.729) defaults `requestChecksumCalculation` to
    // `WHEN_SUPPORTED`, which embeds an `x-amz-checksum-crc32` query
    // param in presigned PUT/UploadPart URLs that captures the CRC32 of
    // an EMPTY body (the body isn't known at presign time). When the
    // browser later PUTs the actual webm blob, MinIO computes the body
    // CRC, sees it disagree with the signed param, and rejects with
    // BadDigest — which the Vite dev proxy surfaces as `ECONNRESET`.
    //
    // The recorder pre-PR-#22 used single-PUT uploads and worked under
    // the older SDK default. Since the multipart streaming path landed,
    // every UploadPart presign has carried this stale CRC param — no
    // part has ever uploaded successfully on this version of the SDK.
    //
    // `WHEN_REQUIRED` skips checksum middleware unless the caller asks
    // for it explicitly, restoring the older presign-friendly behavior.
    // We apply it to both clients for symmetry; the internal client
    // doesn't presign but does PUT directly, and the same bug bites
    // there if MinIO ever tightens checksum strictness.
    const checksumOverrides = {
      requestChecksumCalculation: 'WHEN_REQUIRED' as const,
      responseChecksumValidation: 'WHEN_REQUIRED' as const,
    };

    // Internal client for direct S3 operations (put, get, delete)
    this.client = new S3Client({
      endpoint: this.internalEndpoint,
      region,
      credentials,
      forcePathStyle: true,
      ...checksumOverrides,
    });

    // Presigning client uses the public endpoint so browser-signed URLs
    // have a Host header that matches what the browser actually sends.
    this.presignClient = new S3Client({
      endpoint: this.publicEndpoint || this.internalEndpoint,
      region,
      credentials,
      forcePathStyle: true,
      ...checksumOverrides,
    });
  }

  async onModuleInit(): Promise<void> {
    await this.ensureBucket();
  }

  private async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      this.logger.log(`Bucket "${this.bucket}" is accessible`);
    } catch (err: unknown) {
      const error = err as { name?: string };
      if (error.name === 'NotFound' || error.name === 'NoSuchBucket') {
        this.logger.warn(`Bucket "${this.bucket}" not found, creating...`);
        await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
        this.logger.log(`Bucket "${this.bucket}" created`);
      } else {
        this.logger.error(`Failed to verify bucket "${this.bucket}"`, err);
        throw err;
      }
    }
  }

  async put(options: PutBlobOptions): Promise<string> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: options.key,
        Body: options.body,
        ContentType: options.contentType,
      }),
    );
    return options.key;
  }

  async get(key: string): Promise<{ body: Buffer; contentType: string }> {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    );
    const bytes = await response.Body!.transformToByteArray();
    return {
      body: Buffer.from(bytes),
      contentType: response.ContentType ?? 'application/octet-stream',
    };
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    );
  }

  async getPresignedUploadUrl(options: PresignedUrlOptions): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: options.key,
      ContentType: options.contentType,
    });
    const url = await getSignedUrl(this.presignClient, command, {
      expiresIn: options.expiresIn ?? 3600,
    });
    // Return a relative path so the browser routes through the dev proxy,
    // avoiding CORS issues with direct cross-origin MinIO requests.
    return this.toRelativePath(url);
  }

  async getPresignedDownloadUrl(options: PresignedUrlOptions): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: options.key,
    });
    const url = await getSignedUrl(this.presignClient, command, {
      expiresIn: options.expiresIn ?? 3600,
    });
    return this.toRelativePath(url);
  }

  // ─── Multipart upload (Q3 streaming webcam recording) ──────────────────

  /**
   * Start a multipart upload. Returns the `UploadId` we'll thread through
   * subsequent UploadPart calls. The browser uploads each part directly
   * to MinIO via presigned URLs — the API server only signs URLs and
   * tracks the parts list, never proxies the binary data itself.
   */
  async createMultipartUpload(options: {
    key: string;
    contentType: string;
  }): Promise<{ uploadId: string }> {
    const result = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: options.key,
        ContentType: options.contentType,
      }),
    );
    if (!result.UploadId) {
      throw new Error('CreateMultipartUpload did not return an UploadId');
    }
    return { uploadId: result.UploadId };
  }

  async getPresignedUploadPartUrl(options: {
    key: string;
    uploadId: string;
    partNumber: number;
    expiresIn?: number;
  }): Promise<string> {
    const command = new UploadPartCommand({
      Bucket: this.bucket,
      Key: options.key,
      UploadId: options.uploadId,
      PartNumber: options.partNumber,
    });
    const url = await getSignedUrl(this.presignClient, command, {
      expiresIn: options.expiresIn ?? 3600,
    });
    return this.toRelativePath(url);
  }

  async completeMultipartUpload(options: {
    key: string;
    uploadId: string;
    parts: CompletedPart[];
  }): Promise<void> {
    if (options.parts.length === 0) {
      // S3/MinIO rejects CompleteMultipartUpload with zero parts. Abort
      // instead so we don't leave dangling state.
      await this.abortMultipartUpload({ key: options.key, uploadId: options.uploadId });
      throw new Error('Cannot complete multipart upload with zero parts (aborted instead)');
    }
    // Spec: parts must be sorted by PartNumber ascending.
    const sorted = [...options.parts].sort((a, b) => (a.PartNumber ?? 0) - (b.PartNumber ?? 0));
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: options.key,
        UploadId: options.uploadId,
        MultipartUpload: { Parts: sorted },
      }),
    );
  }

  async abortMultipartUpload(options: { key: string; uploadId: string }): Promise<void> {
    try {
      await this.client.send(
        new AbortMultipartUploadCommand({
          Bucket: this.bucket,
          Key: options.key,
          UploadId: options.uploadId,
        }),
      );
    } catch (err) {
      // Already-aborted / completed uploads return 404 — safe to swallow.
      this.logger.warn(
        `AbortMultipartUpload failed for ${options.key}: ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
  }

  /**
   * Convert an absolute presigned URL to a relative path.
   * The frontend dev server proxies /s3/ to MinIO, avoiding CORS.
   */
  private toRelativePath(absoluteUrl: string): string {
    try {
      const parsed = new URL(absoluteUrl);
      return `/s3${parsed.pathname}${parsed.search}`;
    } catch {
      return absoluteUrl;
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return true;
    } catch {
      return false;
    }
  }
}
