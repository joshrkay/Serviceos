/**
 * U9 (E7) — Convert a CameraCapture {@link CapturedMedia} into a real `File`
 * so it can be persisted through the job-photos upload pipeline
 * (presign → PUT → attach). The camera produces data-URL blobs in memory;
 * without this conversion those captures only ever lived in React state and
 * vanished on navigation/reload.
 */
import type { CapturedMedia } from '../shared/CameraCapture';

/** Decode a `data:<mime>;base64,<payload>` (or URL-encoded) string into a Blob. */
export function dataUrlToBlob(dataUrl: string): Blob {
  const commaIdx = dataUrl.indexOf(',');
  const header = commaIdx >= 0 ? dataUrl.slice(0, commaIdx) : '';
  const data = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
  const mimeMatch = /^data:([^;,]+)/.exec(header);
  const mime = mimeMatch?.[1] || 'image/jpeg';
  const isBase64 = /;base64/i.test(header);

  let bytes: Uint8Array;
  if (isBase64) {
    const binary = atob(data);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  } else {
    const decoded = decodeURIComponent(data);
    bytes = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
  }
  return new Blob([bytes as BlobPart], { type: mime });
}

/**
 * Build a named `File` from a captured media item. Photos become `.jpg`,
 * videos `.webm`, matching what {@link CameraCapture} encodes.
 *
 * Async because videos (and any capture stored via `URL.createObjectURL`)
 * carry a `blob:` object URL, not a `data:` URL — those must be fetched to
 * recover the real bytes. Decoding a `blob:` URL as data (the previous bug)
 * uploaded ~60 bytes of the URL string itself and silently destroyed the
 * footage while every upload step reported success.
 */
export async function capturedMediaToFile(item: CapturedMedia): Promise<File> {
  const ext = item.type === 'video' ? 'webm' : 'jpg';
  const fallbackType = item.type === 'video' ? 'video/webm' : 'image/jpeg';
  const blob = item.url.startsWith('blob:')
    ? await (await fetch(item.url)).blob()
    : dataUrlToBlob(item.url);
  const type = blob.type || fallbackType;
  return new File([blob], `${item.id}.${ext}`, { type });
}
