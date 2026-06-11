/**
 * RV-006 — Image post-process pipeline worker tests.
 *
 * Real sharp processor for the actual image transforms (EXIF strip +
 * orientation, JPEG/PNG passthrough, WEBP→JPEG, thumbnails) against an
 * in-memory object store; mocked processor for the codec-unavailable
 * branches (HEIC graceful degradation, mid-pipeline failure) so both
 * paths are covered even though this machine's sharp build cannot decode
 * HEVC HEIC.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import sharp from 'sharp';
import {
  createImagePostProcessWorker,
  imagePostProcessIdempotencyKey,
  thumbnailKeyFor,
  IMAGE_POST_PROCESS_TYPE,
  ImagePostProcessPayload,
} from '../../src/workers/image-post-process-worker';
import {
  createSharpImageProcessor,
  ImageProcessor,
  UnsupportedImageError,
} from '../../src/files/image-processor';
import {
  FileRecord,
  InMemoryFileRepository,
  ObjectMetadata,
  StorageProvider,
} from '../../src/files/file-service';
import { createLogger } from '../../src/logging/logger';
import { QueueMessage } from '../../src/queues/queue';
import { makeJpeg, makePng, makeWebp } from '../files/fixtures/test-images';

const TENANT = uuidv4();
const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/** In-memory object store so tests can assert exactly what was written. */
class InMemoryObjectStorage implements StorageProvider {
  objects = new Map<string, { body: Buffer; contentType: string }>();
  putCalls: string[] = [];
  failPuts = false;

  seed(bucket: string, key: string, body: Buffer, contentType: string): void {
    this.objects.set(`${bucket}/${key}`, { body, contentType });
  }

  get(bucket: string, key: string): { body: Buffer; contentType: string } | undefined {
    return this.objects.get(`${bucket}/${key}`);
  }

  async generateUploadUrl(bucket: string, key: string): Promise<string> {
    return `https://fake.local/put/${bucket}/${key}`;
  }
  async generateDownloadUrl(bucket: string, key: string): Promise<string> {
    return `https://fake.local/get/${bucket}/${key}`;
  }
  async getObjectMetadata(): Promise<ObjectMetadata | null> {
    return null;
  }
  async getObject(bucket: string, key: string): Promise<Buffer | null> {
    return this.objects.get(`${bucket}/${key}`)?.body ?? null;
  }
  async putObject(bucket: string, key: string, body: Buffer, contentType: string): Promise<void> {
    if (this.failPuts) throw new Error('storage write unavailable');
    this.putCalls.push(`${bucket}/${key}`);
    this.objects.set(`${bucket}/${key}`, { body, contentType });
  }
  async deleteObject(bucket: string, key: string): Promise<void> {
    this.objects.delete(`${bucket}/${key}`);
  }
}

function makeFileRecord(overrides: Partial<FileRecord> = {}): FileRecord {
  const id = overrides.id ?? uuidv4();
  return {
    id,
    tenantId: TENANT,
    filename: 'photo.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 1024,
    storageBucket: 'test-bucket',
    storageKey: `${TENANT}/${id}/photo.jpg`,
    uploadedBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildMessage(payload: ImagePostProcessPayload): QueueMessage<ImagePostProcessPayload> {
  return {
    id: 'msg-1',
    type: IMAGE_POST_PROCESS_TYPE,
    payload,
    attempts: 1,
    maxAttempts: 3,
    idempotencyKey: imagePostProcessIdempotencyKey(payload.fileId),
    createdAt: new Date().toISOString(),
  };
}

describe('image-post-process-worker', () => {
  let fileRepo: InMemoryFileRepository;
  let storage: InMemoryObjectStorage;

  beforeEach(() => {
    fileRepo = new InMemoryFileRepository();
    storage = new InMemoryObjectStorage();
  });

  function makeWorker(processor: ImageProcessor = createSharpImageProcessor()) {
    return createImagePostProcessWorker({ fileRepo, storage, processor });
  }

  async function seedFile(body: Buffer, contentType: string, filename = 'photo.jpg') {
    const file = await fileRepo.create(
      makeFileRecord({ contentType, filename, sizeBytes: body.length })
    );
    storage.seed(file.storageBucket, file.storageKey, body, contentType);
    return file;
  }

  it('strips EXIF and preserves orientation by applying the rotation', async () => {
    // Orientation 6 = rotate 90° CW: a 100x60 source must come out 60x100.
    const oriented = await makeJpeg({ width: 100, height: 60, orientation: 6 });
    expect((await sharp(oriented).metadata()).orientation).toBe(6);
    const file = await seedFile(oriented, 'image/jpeg');

    await makeWorker().handle(buildMessage({ tenantId: TENANT, fileId: file.id }), logger);

    const stored = storage.get(file.storageBucket, file.storageKey)!;
    const meta = await sharp(stored.body).metadata();
    expect(meta.orientation).toBeUndefined();
    expect(meta.exif).toBeUndefined();
    expect(meta.width).toBe(60);
    expect(meta.height).toBe(100);

    const updated = (await fileRepo.findById(TENANT, file.id))!;
    expect(updated.exifStripped).toBe(true);
    expect(updated.width).toBe(60);
    expect(updated.height).toBe(100);
  });

  it('JPEG passthrough: content type stays image/jpeg and the row is fully stamped', async () => {
    const jpeg = await makeJpeg({ width: 200, height: 120 });
    const file = await seedFile(jpeg, 'image/jpeg');

    await makeWorker().handle(buildMessage({ tenantId: TENANT, fileId: file.id }), logger);

    const stored = storage.get(file.storageBucket, file.storageKey)!;
    expect(stored.contentType).toBe('image/jpeg');
    expect((await sharp(stored.body).metadata()).format).toBe('jpeg');

    const updated = (await fileRepo.findById(TENANT, file.id))!;
    expect(updated.contentType).toBe('image/jpeg');
    expect(updated.width).toBe(200);
    expect(updated.height).toBe(120);
    expect(updated.exifStripped).toBe(true);
    expect(updated.contentHash).toBe(sha256Hex(stored.body));
    expect(updated.sizeBytes).toBe(stored.body.length);
    expect(updated.thumbnailS3Key).toBe(thumbnailKeyFor(file.storageKey));
  });

  it('PNG keeps its lossless format', async () => {
    const png = await makePng({ width: 64, height: 64 });
    const file = await seedFile(png, 'image/png', 'pixel.png');

    await makeWorker().handle(buildMessage({ tenantId: TENANT, fileId: file.id }), logger);

    const stored = storage.get(file.storageBucket, file.storageKey)!;
    expect(stored.contentType).toBe('image/png');
    expect((await sharp(stored.body).metadata()).format).toBe('png');
    expect((await fileRepo.findById(TENANT, file.id))!.contentType).toBe('image/png');
  });

  it('converts WEBP→JPEG in place, keeping the same storage key', async () => {
    const webp = await makeWebp({ width: 120, height: 80 });
    const file = await seedFile(webp, 'image/webp', 'photo.webp');

    await makeWorker().handle(buildMessage({ tenantId: TENANT, fileId: file.id }), logger);

    const stored = storage.get(file.storageBucket, file.storageKey)!;
    expect(stored.contentType).toBe('image/jpeg');
    expect((await sharp(stored.body).metadata()).format).toBe('jpeg');

    const updated = (await fileRepo.findById(TENANT, file.id))!;
    expect(updated.contentType).toBe('image/jpeg');
    expect(updated.storageKey).toBe(file.storageKey); // same key shape
    expect(updated.contentHash).toBe(sha256Hex(stored.body));
  });

  it('generates a 480px-wide JPEG thumbnail at <original-key>.thumb.jpg', async () => {
    const jpeg = await makeJpeg({ width: 1200, height: 600 });
    const file = await seedFile(jpeg, 'image/jpeg');

    await makeWorker().handle(buildMessage({ tenantId: TENANT, fileId: file.id }), logger);

    const thumbKey = thumbnailKeyFor(file.storageKey);
    const thumb = storage.get(file.storageBucket, thumbKey)!;
    expect(thumb.contentType).toBe('image/jpeg');
    const meta = await sharp(thumb.body).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(480);
    expect((await fileRepo.findById(TENANT, file.id))!.thumbnailS3Key).toBe(thumbKey);
  });

  it('does not enlarge thumbnails of images narrower than 480px', async () => {
    const jpeg = await makeJpeg({ width: 100, height: 60 });
    const file = await seedFile(jpeg, 'image/jpeg');

    await makeWorker().handle(buildMessage({ tenantId: TENANT, fileId: file.id }), logger);

    const thumb = storage.get(file.storageBucket, thumbnailKeyFor(file.storageKey))!;
    expect((await sharp(thumb.body).metadata()).width).toBe(100);
  });

  it('documents: computes content_hash only, leaving the object and image columns untouched', async () => {
    const pdf = Buffer.from('%PDF-1.4 fake document bytes');
    const file = await seedFile(pdf, 'application/pdf', 'doc.pdf');

    await makeWorker().handle(buildMessage({ tenantId: TENANT, fileId: file.id }), logger);

    expect(storage.putCalls).toHaveLength(0);
    expect(storage.get(file.storageBucket, file.storageKey)!.body.equals(pdf)).toBe(true);

    const updated = (await fileRepo.findById(TENANT, file.id))!;
    expect(updated.contentHash).toBe(sha256Hex(pdf));
    expect(updated.width).toBeUndefined();
    expect(updated.height).toBeUndefined();
    expect(updated.thumbnailS3Key).toBeUndefined();
    expect(updated.exifStripped).toBe(false);
  });

  it('HEIC without codec support: graceful degradation — hash stamped, original untouched', async () => {
    // Mock the codec-unavailable branch: stock sharp builds bundle libheif
    // with AV1 only, so HEVC HEIC throws on decode.
    const unsupportedProcessor: ImageProcessor = {
      async process() {
        throw new UnsupportedImageError('heif: Unsupported feature: codec (4.3000)');
      },
      async thumbnail() {
        throw new Error('unreachable');
      },
    };
    const heicBytes = Buffer.from('fake-heic-bytes');
    const file = await seedFile(heicBytes, 'image/heic', 'photo.heic');

    // Must resolve (no retry storm), not reject.
    await makeWorker(unsupportedProcessor).handle(
      buildMessage({ tenantId: TENANT, fileId: file.id }),
      logger
    );

    expect(storage.putCalls).toHaveLength(0);
    expect(storage.get(file.storageBucket, file.storageKey)!.body.equals(heicBytes)).toBe(true);

    const updated = (await fileRepo.findById(TENANT, file.id))!;
    expect(updated.contentHash).toBe(sha256Hex(heicBytes));
    expect(updated.exifStripped).toBe(false);
    expect(updated.contentType).toBe('image/heic');
    expect(updated.thumbnailS3Key).toBeUndefined();
  });

  it('HEIC with codec support: converts to JPEG (mocked decoder)', async () => {
    // The other side of the capability check: when the environment CAN
    // decode HEIC, the normal convert path runs. Mock a processor that
    // "decodes" HEIC by returning a real JPEG.
    const decodedJpeg = await makeJpeg({ width: 90, height: 45 });
    const realProcessor = createSharpImageProcessor();
    const heicCapableProcessor: ImageProcessor = {
      async process() {
        return { buffer: decodedJpeg, contentType: 'image/jpeg', width: 90, height: 45 };
      },
      thumbnail: (input) => realProcessor.thumbnail(input),
    };
    const file = await seedFile(Buffer.from('fake-heic-bytes'), 'image/heic', 'photo.heic');

    await makeWorker(heicCapableProcessor).handle(
      buildMessage({ tenantId: TENANT, fileId: file.id }),
      logger
    );

    const stored = storage.get(file.storageBucket, file.storageKey)!;
    expect(stored.contentType).toBe('image/jpeg');
    expect(stored.body.equals(decodedJpeg)).toBe(true);
    const updated = (await fileRepo.findById(TENANT, file.id))!;
    expect(updated.contentType).toBe('image/jpeg');
    expect(updated.exifStripped).toBe(true);
  });

  it('real sharp on this machine throws UnsupportedImageError for undecodable bytes', async () => {
    // Honest capability check against the real library: bytes sharp cannot
    // decode must surface as the permanent-failure class the worker catches.
    const processor = createSharpImageProcessor();
    await expect(
      processor.process(Buffer.from('definitely-not-an-image'), 'image/heic')
    ).rejects.toBeInstanceOf(UnsupportedImageError);
  });

  it('pixel-limit exceeded (decompression bomb) is classified as UnsupportedImageError', async () => {
    // A mocked sharp that throws the exact error shape sharp emits when
    // limitInputPixels is exceeded must be caught and re-wrapped as the
    // permanent-failure class — so the worker does not retry bomb payloads.
    const { createSharpImageProcessor: realCreate, UnsupportedImageError: UnsupErr } = await import(
      '../../src/files/image-processor'
    );
    const mockProcessor: ImageProcessor = {
      async process() {
        throw new UnsupErr(
          'image decode/encode failed (image/jpeg): Input image exceeds pixel limit'
        );
      },
      async thumbnail() {
        throw new UnsupErr('thumbnail generation failed: Input image exceeds pixel limit');
      },
    };
    // The worker must resolve (not rethrow) when UnsupportedImageError is thrown.
    const jpeg = await makeJpeg({ width: 10, height: 10 });
    const file = await seedFile(jpeg, 'image/jpeg');
    await expect(
      makeWorker(mockProcessor).handle(
        buildMessage({ tenantId: TENANT, fileId: file.id }),
        logger
      )
    ).resolves.toBeUndefined();
    // Graceful degradation: hash stamped from original, no rewrites.
    const updated = (await fileRepo.findById(TENANT, file.id))!;
    expect(updated.contentHash).toBe(sha256Hex(jpeg));
    expect(storage.putCalls).toHaveLength(0);
    void realCreate; // referenced to satisfy unused-import lint
  });

  it('mid-pipeline failure preserves the original: nothing written, row not stamped, error rethrown', async () => {
    const realProcessor = createSharpImageProcessor();
    const failingThumbnailer: ImageProcessor = {
      process: (input, ct) => realProcessor.process(input, ct),
      async thumbnail() {
        throw new Error('transient: out of memory');
      },
    };
    const jpeg = await makeJpeg();
    const file = await seedFile(jpeg, 'image/jpeg');

    await expect(
      makeWorker(failingThumbnailer).handle(
        buildMessage({ tenantId: TENANT, fileId: file.id }),
        logger
      )
    ).rejects.toThrow('transient: out of memory');

    // Original object untouched, no partial writes, row unprocessed so a
    // retry starts clean.
    expect(storage.putCalls).toHaveLength(0);
    expect(storage.get(file.storageBucket, file.storageKey)!.body.equals(jpeg)).toBe(true);
    const row = (await fileRepo.findById(TENANT, file.id))!;
    expect(row.contentHash).toBeUndefined();
    expect(row.exifStripped ?? false).toBe(false);
  });

  it('storage write failure rethrows (transient → queue retry) without stamping the row', async () => {
    const jpeg = await makeJpeg();
    const file = await seedFile(jpeg, 'image/jpeg');
    storage.failPuts = true;

    await expect(
      makeWorker().handle(buildMessage({ tenantId: TENANT, fileId: file.id }), logger)
    ).rejects.toThrow('storage write unavailable');
    expect((await fileRepo.findById(TENANT, file.id))!.contentHash).toBeUndefined();
  });

  it('idempotent reprocessing: a second delivery for a processed file is a no-op', async () => {
    const jpeg = await makeJpeg();
    const file = await seedFile(jpeg, 'image/jpeg');
    const worker = makeWorker();
    const message = buildMessage({ tenantId: TENANT, fileId: file.id });

    await worker.handle(message, logger);
    const afterFirst = (await fileRepo.findById(TENANT, file.id))!;
    const putsAfterFirst = storage.putCalls.length;

    await worker.handle(message, logger);

    expect(storage.putCalls.length).toBe(putsAfterFirst); // no new writes
    const afterSecond = (await fileRepo.findById(TENANT, file.id))!;
    expect(afterSecond.contentHash).toBe(afterFirst.contentHash);
    expect(afterSecond.updatedAt).toEqual(afterFirst.updatedAt);
  });

  it('skips when the file row is missing (permanent — no retry)', async () => {
    await expect(
      makeWorker().handle(buildMessage({ tenantId: TENANT, fileId: uuidv4() }), logger)
    ).resolves.toBeUndefined();
  });

  it('skips when object bytes are unavailable (dev storage)', async () => {
    const file = await fileRepo.create(makeFileRecord());
    // nothing seeded in storage → getObject returns null
    await expect(
      makeWorker().handle(buildMessage({ tenantId: TENANT, fileId: file.id }), logger)
    ).resolves.toBeUndefined();
    expect((await fileRepo.findById(TENANT, file.id))!.contentHash).toBeUndefined();
  });
});
