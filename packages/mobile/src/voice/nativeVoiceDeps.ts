import * as Crypto from 'expo-crypto';
import * as FileSystem from 'expo-file-system';
import type { FileUploader } from './uploadAndTranscribe';

// Native implementations of the injectable voice deps. Kept out of
// uploadAndTranscribe.ts so that pure-logic stays RN-free and unit-testable.

export function makeIdempotencyKey(): string {
  return Crypto.randomUUID();
}

/** PUT a local file URI to the signed URL via expo-file-system. */
export const uploadFile: FileUploader = async (uploadUrl, fileUri, contentType) => {
  const res = await FileSystem.uploadAsync(uploadUrl, fileUri, {
    httpMethod: 'PUT',
    uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
    headers: { 'Content-Type': contentType },
  });
  return { ok: res.status >= 200 && res.status < 300, status: res.status };
};
