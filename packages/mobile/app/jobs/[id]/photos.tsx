import { useLocalSearchParams } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as FileSystem from 'expo-file-system';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Linking, Pressable, Text, View } from 'react-native';
import { ScreenShell } from '../../../src/components/ScreenShell';
import { useApiClient } from '../../../src/lib/useApiClient';
import { uploadFile } from '../../../src/jobs/nativeJobPhotoDeps';
import {
  uploadJobPhoto,
  listJobPhotos,
  deleteJobPhoto,
  type JobPhoto,
  type JobPhotoCategory,
} from '../../../src/jobs/uploadJobPhoto';

const CATEGORIES: JobPhotoCategory[] = ['before', 'after', 'problem', 'completion', 'other'];

export default function JobPhotos() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = Array.isArray(params.id) ? params.id[0] : (params.id ?? '');
  const api = useApiClient();

  const cameraRef = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [photos, setPhotos] = useState<JobPhoto[]>([]);
  const [category, setCategory] = useState<JobPhotoCategory>('before');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);

  const refresh = useCallback(async () => {
    if (!id) return;
    try {
      setPhotos(await listJobPhotos(id, api));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load photos');
    }
  }, [api, id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // U2 (E9 follow-up): delete a wrong photo/video. The DELETE endpoint audits +
  // gates server-side; on success we refetch, on failure we surface the error
  // (no phantom removal).
  const remove = useCallback(
    async (photoId: string) => {
      if (!id) return;
      setError(null);
      try {
        await deleteJobPhoto(id, photoId, api);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to delete photo');
      }
    },
    [api, id, refresh],
  );

  const capture = useCallback(async () => {
    if (!id || saving) return;
    setSaving(true);
    setError(null);
    try {
      const shot = await cameraRef.current?.takePictureAsync();
      if (!shot?.uri) throw new Error('Capture failed. Please retry.');
      // expo-camera writes a JPEG; size it from the filesystem for the presign.
      const info = await FileSystem.getInfoAsync(shot.uri, { size: true });
      const sizeBytes = (info as { size?: number }).size ?? 0;
      await uploadJobPhoto(
        id,
        { fileUri: shot.uri, contentType: 'image/jpeg', sizeBytes },
        category,
        { api, uploadFile },
        { takenAt: new Date().toISOString() },
      );
      await refresh();
      setCameraOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Photo upload failed');
    } finally {
      setSaving(false);
    }
  }, [api, category, id, refresh, saving]);

  return (
    <ScreenShell title="Job photos" backLabel="‹ Job" subtitle={`Job ${id.slice(0, 8)}`}>
      {error ? (
        <Text accessibilityRole="alert" className="mb-3 text-sm text-destructive">
          {error}
        </Text>
      ) : null}

      {/* Category selector */}
      <View className="mb-4 flex-row flex-wrap gap-2">
        {CATEGORIES.map((c) => (
          <Pressable
            key={c}
            accessibilityRole="button"
            accessibilityLabel={`Category ${c}`}
            onPress={() => setCategory(c)}
            className={`min-h-11 justify-center rounded-full border px-4 ${
              c === category ? 'border-primary bg-primary' : 'border-border bg-card'
            }`}
          >
            <Text className={c === category ? 'text-primaryForeground' : 'text-foreground'}>{c}</Text>
          </Pressable>
        ))}
      </View>

      {cameraOpen ? (
        <View className="mb-4">
          <CameraView ref={cameraRef} facing="back" style={{ height: 320, borderRadius: 12 }} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Capture photo"
            disabled={saving}
            onPress={() => void capture()}
            className="mt-3 min-h-11 items-center justify-center rounded-xl bg-primary"
          >
            <Text className="text-base font-semibold text-primaryForeground">
              {saving ? 'Saving…' : 'Capture'}
            </Text>
          </Pressable>
        </View>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Add photo"
          onPress={async () => {
            if (!permission?.granted) {
              const res = await requestPermission();
              if (!res?.granted) {
                setError('Camera access is required to add photos.');
                return;
              }
            }
            setCameraOpen(true);
          }}
          className="mb-4 min-h-11 items-center justify-center rounded-xl border-2 border-dashed border-border"
        >
          <Text className="text-base text-mutedForeground">Add photo</Text>
        </Pressable>
      )}

      {/* Persisted gallery */}
      {photos.length === 0 ? (
        <Text className="text-sm text-mutedForeground">No photos yet for this job.</Text>
      ) : (
        <View className="flex-row flex-wrap gap-2">
          {photos.map((p) => (
            <View key={p.id} className="overflow-hidden rounded-xl border border-border">
              {p.contentType?.startsWith('video/') ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={p.notes ?? `Play ${p.category} video`}
                  onPress={() => void Linking.openURL(p.downloadUrl)}
                  style={{ width: 104, height: 104 }}
                  className="items-center justify-center bg-card"
                >
                  <Text className="text-2xl text-foreground">▶</Text>
                  <Text className="text-xs text-mutedForeground">Video</Text>
                </Pressable>
              ) : (
                <Image
                  source={{ uri: p.downloadUrl }}
                  accessibilityLabel={p.notes ?? `${p.category} photo`}
                  style={{ width: 104, height: 104 }}
                />
              )}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Delete ${p.category} photo`}
                onPress={() => void remove(p.id)}
                className="min-h-11 items-center justify-center bg-card"
              >
                <Text className="text-sm text-destructive">Delete</Text>
              </Pressable>
            </View>
          ))}
        </View>
      )}

      {saving ? <ActivityIndicator className="mt-3" /> : null}
    </ScreenShell>
  );
}
