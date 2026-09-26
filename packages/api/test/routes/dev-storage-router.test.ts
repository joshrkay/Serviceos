/**
 * #1273 — `/storage-dev` (createDevStorageRouter) is mounted before /api
 * Clerk auth (a real S3 presigned URL needs no Clerk session either), but
 * unlike a real S3 presign, it previously did zero validation of its own:
 * any PUT or GET to any path succeeded. This pinned it as an unauthenticated
 * read/write oracle whenever the route was mounted.
 *
 * The fix binds every request to the per-boot HMAC token DevStorageProvider
 * embeds in the URLs it hands back from generateUploadUrl/generateDownloadUrl
 * — mirrors how S3StorageProvider's SigV4 signature is the real backend's
 * authorization. These tests exercise createDevStorageRouter directly over
 * a real HTTP server (supertest), independent of the app.ts wiring covered
 * by test/app/dev-storage-route.route.test.ts.
 */
import express from 'express';
import request from 'supertest';
import { describe, it, expect } from 'vitest';
import { createDevStorageRouter } from '../../src/routes/files';
import { DevStorageProvider, signDevStorageToken } from '../../src/files/storage-provider';

const SECRET = 'test-dev-storage-secret';

function buildApp(secret: string = SECRET) {
  const app = express();
  app.use('/storage-dev', createDevStorageRouter(secret));
  return app;
}

describe('createDevStorageRouter (#1273)', () => {
  it('rejects a PUT with no token at all', async () => {
    const app = buildApp();
    const res = await request(app)
      .put('/storage-dev/tenant-1/file-1/voice.webm')
      .set('content-type', 'audio/webm')
      .send('raw-bytes');
    expect(res.status).toBe(401);
  });

  it('rejects a GET with no token at all', async () => {
    const app = buildApp();
    const res = await request(app).get('/storage-dev/tenant-1/file-1/voice.webm');
    expect(res.status).toBe(401);
  });

  it('rejects a PUT with a garbage/forged token', async () => {
    const app = buildApp();
    const res = await request(app)
      .put('/storage-dev/tenant-1/file-1/voice.webm?token=not-a-real-token')
      .set('content-type', 'audio/webm')
      .send('raw-bytes');
    expect(res.status).toBe(401);
  });

  it('rejects a PUT using a token signed for a DIFFERENT key', async () => {
    const app = buildApp();
    const wrongKeyToken = signDevStorageToken(SECRET, 'PUT', 'tenant-1/file-1/OTHER.webm');
    const res = await request(app)
      .put(`/storage-dev/tenant-1/file-1/voice.webm?token=${wrongKeyToken}`)
      .set('content-type', 'audio/webm')
      .send('raw-bytes');
    expect(res.status).toBe(401);
  });

  it('rejects a GET using the PUT token for the same key (method-bound)', async () => {
    const app = buildApp();
    const putToken = signDevStorageToken(SECRET, 'PUT', 'tenant-1/file-1/voice.webm');
    const res = await request(app).get(`/storage-dev/tenant-1/file-1/voice.webm?token=${putToken}`);
    expect(res.status).toBe(401);
  });

  it('rejects a request signed with a different secret than the router was mounted with', async () => {
    const app = buildApp();
    const foreignToken = signDevStorageToken('a-different-secret', 'PUT', 'tenant-1/file-1/voice.webm');
    const res = await request(app)
      .put(`/storage-dev/tenant-1/file-1/voice.webm?token=${foreignToken}`)
      .set('content-type', 'audio/webm')
      .send('raw-bytes');
    expect(res.status).toBe(401);
  });

  it('accepts a PUT with a valid token, and a subsequent GET with a valid token round-trips the bytes', async () => {
    const app = buildApp();
    const key = 'tenant-1/file-1/voice.webm';
    const putToken = signDevStorageToken(SECRET, 'PUT', key);
    // text/plain so supertest/superagent populates res.text for the GET
    // assertion below — the router itself is content-type agnostic (it
    // stores whatever `content-type` header the PUT carried and echoes it
    // back), so this doesn't dodge anything under test.
    const putRes = await request(app)
      .put(`/storage-dev/${key}?token=${putToken}`)
      .set('content-type', 'text/plain')
      .send('hello-bytes');
    expect(putRes.status).toBe(200);

    const getToken = signDevStorageToken(SECRET, 'GET', key);
    const getRes = await request(app).get(`/storage-dev/${key}?token=${getToken}`);
    expect(getRes.status).toBe(200);
    expect(getRes.text).toBe('hello-bytes');
    expect(getRes.headers['content-type']).toContain('text/plain');
  });

  it('end-to-end through DevStorageProvider: the URLs it generates are accepted by the router built with the same secret', async () => {
    const app = buildApp();
    const provider = new DevStorageProvider({
      bucket: 'serviceos-dev',
      publicUrlBase: 'http://localhost:0/storage-dev',
      secret: SECRET,
    });
    const key = 'tenant-9/file-9/note.txt';
    const uploadUrl = await provider.generateUploadUrl('serviceos-dev', key, 'text/plain');
    const uploadPath = uploadUrl.replace('http://localhost:0', '');
    const putRes = await request(app)
      .put(uploadPath)
      .set('content-type', 'text/plain')
      .send('note-bytes');
    expect(putRes.status).toBe(200);

    const downloadUrl = await provider.generateDownloadUrl('serviceos-dev', key);
    const downloadPath = downloadUrl.replace('http://localhost:0', '');
    const getRes = await request(app).get(downloadPath);
    expect(getRes.status).toBe(200);
    expect(getRes.text).toBe('note-bytes');
  });

  it('a GET for a key that was never PUT (but carries a validly-signed token) 404s, not 401', async () => {
    const app = buildApp();
    const key = 'tenant-1/never-uploaded.webm';
    const getToken = signDevStorageToken(SECRET, 'GET', key);
    const res = await request(app).get(`/storage-dev/${key}?token=${getToken}`);
    expect(res.status).toBe(404);
  });
});
