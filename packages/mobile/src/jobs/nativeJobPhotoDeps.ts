import * as FileSystem from 'expo-file-system';
import type { FileUploader } from './uploadJobPhoto';

// Native implementation of the injectable job-photo uploader. Kept out of
// uploadJobPhoto.ts so the pure logic stays RN-free and unit-testable —
// mirrors src/voice/nativeVoiceDeps.ts.

/** PUT a local file URI to the signed URL via expo-file-system. */
export const uploadFile: FileUploader = async (uploadUrl, fileUri, contentType) => {
  const res = await FileSystem.uploadAsync(uploadUrl, fileUri, {
    httpMethod: 'PUT',
    uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
    headers: { 'Content-Type': contentType },
  });
  return { ok: res.status >= 200 && res.status < 300, status: res.status };
};
