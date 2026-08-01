// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createElement, forwardRef, useImperativeHandle } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
// Test-only helper lives on the stub; `react-native` is vitest-aliased to it at
// runtime (same module instance), but tsc resolves the real RN types, so import
// the helper from the stub path directly.
import { __setLinkingOpenURL } from '../../test/stubs/react-native';
import type { CapturedPhoto, JobPhoto } from '../jobs/uploadJobPhoto';

// The screen-test block (below) mocks ../jobs/uploadJobPhoto so the screen
// renders against stubs. The logic block must exercise the REAL pipeline, so it
// loads the unmocked implementation via importActual in a beforeAll (kept off
// the top level so the typecheck lane's module target stays happy).
let uploadJobPhoto: typeof import('../jobs/uploadJobPhoto').uploadJobPhoto;
let listJobPhotos: typeof import('../jobs/uploadJobPhoto').listJobPhotos;
let deleteJobPhoto: typeof import('../jobs/uploadJobPhoto').deleteJobPhoto;
beforeAll(async () => {
  const real = await vi.importActual<typeof import('../jobs/uploadJobPhoto')>(
    '../jobs/uploadJobPhoto',
  );
  uploadJobPhoto = real.uploadJobPhoto;
  listJobPhotos = real.listJobPhotos;
  deleteJobPhoto = real.deleteJobPhoto;
});

// ── Shared fixtures ──────────────────────────────────────────────────────────
function jsonRes(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makePhoto(id: string, category: JobPhoto['category'] = 'before'): JobPhoto {
  return {
    id,
    tenantId: 't1',
    jobId: 'j1',
    uploadedByUserId: 'u1',
    fileId: `f-${id}`,
    category,
    createdAt: '2026-06-27T10:00:00.000Z',
    downloadUrl: `https://cdn.example/${id}.jpg`,
    filename: `${id}.jpg`,
    contentType: 'image/jpeg',
    sizeBytes: 10,
  };
}

const captured: CapturedPhoto = {
  fileUri: 'file:///cap.jpg',
  contentType: 'image/jpeg',
  sizeBytes: 4321,
};

// ── Logic module: presign → PUT → attach ─────────────────────────────────────
describe('uploadJobPhoto (logic)', () => {
  function makeDeps(routes: Record<string, () => Response>, over = {}) {
    const api = vi.fn(async (path: string, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${path}`;
      const handler = routes[key];
      if (!handler) throw new Error(`unexpected request: ${key}`);
      return handler();
    });
    return {
      api,
      uploadFile: vi.fn(async () => ({ ok: true, status: 200 })),
      now: () => 1000,
      ...over,
    };
  }

  const HAPPY = {
    'POST /api/jobs/j1/photos/presign-upload': () =>
      jsonRes({ fileId: 'f1', uploadUrl: 'https://s3/put?sig=x' }, 201),
    'POST /api/jobs/j1/photos': () => jsonRes(makePhoto('p1'), 201),
  };

  it('runs presign → PUT → attach and returns the persisted photo', async () => {
    const deps = makeDeps(HAPPY);
    const photo = await uploadJobPhoto('j1', captured, 'after', deps, {
      takenAt: '2026-06-27T10:00:00.000Z',
    });

    expect(photo.id).toBe('p1');
    // PUT goes to the signed URL with the local file URI.
    expect(deps.uploadFile).toHaveBeenCalledWith('https://s3/put?sig=x', 'file:///cap.jpg', 'image/jpeg');
    // presign body carries content type + size.
    const presignCall = deps.api.mock.calls.find(
      (c) => c[0] === '/api/jobs/j1/photos/presign-upload',
    );
    expect(JSON.parse((presignCall![1] as RequestInit).body as string)).toMatchObject({
      contentType: 'image/jpeg',
      sizeBytes: 4321,
    });
    // attach body carries the fileId + category.
    const attachCall = deps.api.mock.calls.find(
      (c) => c[0] === '/api/jobs/j1/photos' && (c[1] as RequestInit)?.method === 'POST',
    );
    expect(JSON.parse((attachCall![1] as RequestInit).body as string)).toMatchObject({
      fileId: 'f1',
      category: 'after',
      takenAt: '2026-06-27T10:00:00.000Z',
    });
  });

  it('throws when presign is not ok', async () => {
    const deps = makeDeps({
      'POST /api/jobs/j1/photos/presign-upload': () => jsonRes({}, 400),
    });
    await expect(uploadJobPhoto('j1', captured, 'before', deps)).rejects.toThrow(/signed upload URL/);
  });

  it('throws when the PUT fails (no attach attempted)', async () => {
    const deps = makeDeps(HAPPY, { uploadFile: vi.fn(async () => ({ ok: false, status: 500 })) });
    await expect(uploadJobPhoto('j1', captured, 'before', deps)).rejects.toThrow(/upload failed/i);
    expect(deps.api).not.toHaveBeenCalledWith('/api/jobs/j1/photos', expect.anything());
  });

  it('throws when the attach call fails', async () => {
    const deps = makeDeps({
      ...HAPPY,
      'POST /api/jobs/j1/photos': () => jsonRes({}, 422),
    });
    await expect(uploadJobPhoto('j1', captured, 'before', deps)).rejects.toThrow(/attach/i);
  });

  it('listJobPhotos returns the server list', async () => {
    const api = vi.fn(async () => jsonRes([makePhoto('p1'), makePhoto('p2')]));
    const list = await listJobPhotos('j1', api);
    expect(list.map((p) => p.id)).toEqual(['p1', 'p2']);
  });

  it('deleteJobPhoto issues a DELETE to the photo route', async () => {
    const api = vi.fn(async () => new Response(null, { status: 204 }));
    await deleteJobPhoto('j1', 'p1', api);
    expect(api).toHaveBeenCalledWith('/api/jobs/j1/photos/p1', { method: 'DELETE' });
  });

  it('deleteJobPhoto throws when the server rejects', async () => {
    const api = vi.fn(async () => jsonRes({}, 403));
    await expect(deleteJobPhoto('j1', 'p1', api)).rejects.toThrow(/delete/i);
  });
});

// ── Screen: capture → upload → refetch shows photo; error surfaced ───────────
const h = vi.hoisted(() => ({
  api: vi.fn(),
  uploadJobPhoto: vi.fn(),
  listJobPhotos: vi.fn(),
  deleteJobPhoto: vi.fn(),
  uploadFile: vi.fn(),
  takePicture: vi.fn(),
  granted: true,
  requestPermission: vi.fn(),
  getInfoAsync: vi.fn(),
  openURL: vi.fn(),
}));

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: 'j1' }),
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
}));
vi.mock('../lib/useApiClient', () => ({ useApiClient: () => h.api }));
vi.mock('expo-file-system', () => ({
  getInfoAsync: (...args: unknown[]) => h.getInfoAsync(...args),
  uploadAsync: vi.fn(),
  FileSystemUploadType: { BINARY_CONTENT: 'BINARY_CONTENT' },
}));
vi.mock('../jobs/nativeJobPhotoDeps', () => ({ uploadFile: (...a: unknown[]) => h.uploadFile(...a) }));
vi.mock('../jobs/uploadJobPhoto', async () => {
  const real = await vi.importActual<typeof import('../jobs/uploadJobPhoto')>('../jobs/uploadJobPhoto');
  return {
    ...real,
    uploadJobPhoto: (...a: unknown[]) => h.uploadJobPhoto(...a),
    listJobPhotos: (...a: unknown[]) => h.listJobPhotos(...a),
    deleteJobPhoto: (...a: unknown[]) => h.deleteJobPhoto(...a),
  };
});
vi.mock('expo-camera', () => ({
  CameraView: forwardRef((_props: Record<string, unknown>, ref) => {
    useImperativeHandle(ref, () => ({ takePictureAsync: h.takePicture }));
    return createElement('div', { 'data-testid': 'camera-view' });
  }),
  useCameraPermissions: () => [
    { granted: h.granted },
    h.requestPermission,
  ],
}));

// eslint-disable-next-line import/first
import JobPhotosScreen from '../../app/jobs/[id]/photos';

beforeEach(() => {
  vi.clearAllMocks();
  h.granted = true;
  h.requestPermission.mockResolvedValue({ granted: true });
  h.getInfoAsync.mockResolvedValue({ exists: true, size: 4321 });
  h.takePicture.mockResolvedValue({ uri: 'file:///cap.jpg' });
  h.listJobPhotos.mockResolvedValue([]);
  h.uploadJobPhoto.mockResolvedValue(makePhoto('p-new'));
  h.deleteJobPhoto.mockResolvedValue(undefined);
});

afterEach(() => cleanup());

describe('Job photos screen', () => {
  it('captures a photo, uploads it, and the refetch shows the persisted photo', async () => {
    // First load: empty. After upload: the persisted photo.
    h.listJobPhotos.mockResolvedValueOnce([]).mockResolvedValue([makePhoto('p-new')]);

    const { getByText, container } = render(createElement(JobPhotosScreen));

    fireEvent.click(getByText('Add photo'));
    await waitFor(() => expect(getByText('Capture')).toBeTruthy());

    fireEvent.click(getByText('Capture'));

    await waitFor(() =>
      expect(h.uploadJobPhoto).toHaveBeenCalledWith(
        'j1',
        expect.objectContaining({ fileUri: 'file:///cap.jpg', contentType: 'image/jpeg', sizeBytes: 4321 }),
        'before',
        expect.objectContaining({ api: h.api, uploadFile: expect.any(Function) }),
        expect.objectContaining({ takenAt: expect.any(String) }),
      ),
    );

    // Persisted photo renders from the refetched server list.
    await waitFor(() => {
      const img = container.querySelector('img[src="https://cdn.example/p-new.jpg"]');
      expect(img).not.toBeNull();
    });
  });

  it('surfaces an upload error and shows no phantom photo', async () => {
    h.uploadJobPhoto.mockRejectedValue(new Error('Could not attach the photo to this job.'));
    h.listJobPhotos.mockResolvedValue([]); // server still empty

    const { getByText, container, findByText } = render(createElement(JobPhotosScreen));

    fireEvent.click(getByText('Add photo'));
    await waitFor(() => expect(getByText('Capture')).toBeTruthy());
    fireEvent.click(getByText('Capture'));

    expect(await findByText('Could not attach the photo to this job.')).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
  });

  it('surfaces a denied camera permission', async () => {
    h.granted = false;
    h.requestPermission.mockResolvedValue({ granted: false });

    const { getByText, findByText } = render(createElement(JobPhotosScreen));
    fireEvent.click(getByText('Add photo'));

    expect(await findByText('Camera access is required to add photos.')).toBeTruthy();
    expect(h.uploadJobPhoto).not.toHaveBeenCalled();
  });

  it('renders photos already persisted on load', async () => {
    h.listJobPhotos.mockResolvedValue([makePhoto('p-existing')]);
    const { container } = render(createElement(JobPhotosScreen));
    await waitFor(() => {
      expect(container.querySelector('img[src="https://cdn.example/p-existing.jpg"]')).not.toBeNull();
    });
  });

  it('deletes a photo: the delete affordance calls deleteJobPhoto and refetches', async () => {
    // Loaded with the photo, then empty after the delete refetch.
    h.listJobPhotos
      .mockResolvedValueOnce([makePhoto('p-del')])
      .mockResolvedValue([]);

    const { getByText, container } = render(createElement(JobPhotosScreen));
    await waitFor(() => {
      expect(container.querySelector('img[src="https://cdn.example/p-del.jpg"]')).not.toBeNull();
    });

    fireEvent.click(getByText('Delete'));

    await waitFor(() => expect(h.deleteJobPhoto).toHaveBeenCalledWith('j1', 'p-del', h.api));
    // Refetch ran (second listJobPhotos call) and the photo is gone.
    await waitFor(() => {
      expect(container.querySelector('img[src="https://cdn.example/p-del.jpg"]')).toBeNull();
    });
  });

  it('surfaces a delete error and keeps the photo (no phantom removal)', async () => {
    h.listJobPhotos.mockResolvedValue([makePhoto('p-err')]);
    h.deleteJobPhoto.mockRejectedValue(new Error('Could not delete this photo.'));

    const { getByText, findByText, container } = render(createElement(JobPhotosScreen));
    await waitFor(() => {
      expect(container.querySelector('img[src="https://cdn.example/p-err.jpg"]')).not.toBeNull();
    });

    fireEvent.click(getByText('Delete'));

    expect(await findByText('Could not delete this photo.')).toBeTruthy();
    // The photo is still present — the failed delete did not remove it.
    expect(container.querySelector('img[src="https://cdn.example/p-err.jpg"]')).not.toBeNull();
  });

  it('renders a video/* item as a play affordance (not an <Image>) and opens the URL', async () => {
    const openURL = vi.fn(async () => undefined);
    __setLinkingOpenURL(openURL);
    h.listJobPhotos.mockResolvedValue([
      {
        ...makePhoto('v1'),
        category: 'other' as const,
        contentType: 'video/webm',
        downloadUrl: 'https://cdn.example/v1.webm',
        filename: 'v1.webm',
      },
    ]);

    const { getByText, container } = render(createElement(JobPhotosScreen));
    await waitFor(() => expect(getByText('Video')).toBeTruthy());
    // No <img> rendered for the video tile.
    expect(container.querySelector('img[src="https://cdn.example/v1.webm"]')).toBeNull();

    fireEvent.click(getByText('▶'));
    expect(openURL).toHaveBeenCalledWith('https://cdn.example/v1.webm');
  });
});
