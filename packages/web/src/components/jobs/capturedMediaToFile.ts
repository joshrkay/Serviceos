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
 */
export function capturedMediaToFile(item: CapturedMedia): File {
  const blob = dataUrlToBlob(item.url);
  const ext = item.type === 'video' ? 'webm' : 'jpg';
  const type = blob.type || (item.type === 'video' ? 'video/webm' : 'image/jpeg');
  return new File([blob], `${item.id}.${ext}`, { type });
}
