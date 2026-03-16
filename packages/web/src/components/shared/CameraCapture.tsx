import { useState, useEffect, useRef, useCallback } from 'react';
import {
  X, ZapOff, Zap, RotateCcw, Video, Camera,
  StopCircle, CheckCircle, Play, ChevronRight, ImageIcon,
} from 'lucide-react';

type CaptureMode = 'photo' | 'video';
type FacingMode = 'user' | 'environment';

export interface CapturedMedia {
  id: string;
  type: 'photo' | 'video';
  url: string;
  thumb?: string;
  capturedAt: string; // ISO timestamp
}

interface Props {
  onClose: (media: CapturedMedia[]) => void;
}

// ─── Thumbnail strip item ─────────────────────────────────────────
function Thumb({ item, index }: { item: CapturedMedia; index: number }) {
  return (
    <div
      className="relative shrink-0 rounded-lg overflow-hidden border-2 border-white/20"
      style={{ width: 56, height: 56 }}
    >
      {item.type === 'photo' ? (
        <img src={item.url} className="w-full h-full object-cover" alt={`capture ${index + 1}`} />
      ) : (
        <>
          {item.thumb
            ? <img src={item.thumb} className="w-full h-full object-cover" alt="video" />
            : <div className="w-full h-full bg-slate-800 flex items-center justify-center">
                <Video size={18} className="text-white/60" />
              </div>
          }
          <div className="absolute inset-0 flex items-center justify-center bg-black/30">
            <Play size={14} className="text-white" />
          </div>
          <span className="absolute bottom-0.5 right-0.5 text-white bg-black/50 rounded px-0.5" style={{ fontSize: 8 }}>
            VID
          </span>
        </>
      )}
    </div>
  );
}

// ─── Shutter button ──────────────────────────────────────────────
function ShutterButton({
  mode, isRecording, onPress,
}: {
  mode: CaptureMode;
  isRecording: boolean;
  onPress: () => void;
}) {
  if (mode === 'photo') {
    return (
      <button
        onPointerDown={onPress}
        className="flex items-center justify-center rounded-full bg-white active:scale-90 transition-transform select-none"
        style={{ width: 72, height: 72, boxShadow: '0 0 0 4px rgba(255,255,255,0.25)' }}
      >
        <span className="rounded-full bg-white border-4 border-slate-900/10" style={{ width: 58, height: 58 }} />
      </button>
    );
  }

  // Video mode
  if (isRecording) {
    return (
      <button
        onPointerDown={onPress}
        className="flex items-center justify-center rounded-full active:scale-90 transition-transform select-none relative"
        style={{
          width: 72, height: 72,
          background: 'rgba(255,255,255,0.15)',
          boxShadow: '0 0 0 4px rgba(239,68,68,0.4)',
          animation: 'recRing 1.4s ease-in-out infinite',
        }}
      >
        <span className="rounded-md bg-red-500" style={{ width: 26, height: 26 }} />
      </button>
    );
  }

  return (
    <button
      onPointerDown={onPress}
      className="flex items-center justify-center rounded-full active:scale-90 transition-transform select-none"
      style={{ width: 72, height: 72, boxShadow: '0 0 0 4px rgba(255,255,255,0.25)', background: 'rgba(255,255,255,0.15)' }}
    >
      <span className="rounded-full bg-red-500" style={{ width: 52, height: 52 }} />
    </button>
  );
}

// ─── Main component ───────────────────────────────────────────────
export function CameraCapture({ onClose }: Props) {
  const videoRef    = useRef<HTMLVideoElement>(null);
  const canvasRef   = useRef<HTMLCanvasElement>(null);
  const streamRef   = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef   = useRef<Blob[]>([]);
  const thumbsRef   = useRef<HTMLDivElement>(null);

  const [facing,      setFacing]      = useState<FacingMode>('environment');
  const [mode,        setMode]        = useState<CaptureMode>('photo');
  const [flashOn,     setFlashOn]     = useState(false);
  const [flashFx,     setFlashFx]     = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recSeconds,  setRecSeconds]  = useState(0);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [media,       setMedia]       = useState<CapturedMedia[]>([]);
  const [permAsked,   setPermAsked]   = useState(false);

  // ── Start camera stream ─────────────────────────────────────────
  const startCamera = useCallback(async (newFacing: FacingMode) => {
    try {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
      }
      const constraints: MediaStreamConstraints = {
        video: { facingMode: newFacing, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: true,
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
      setCameraError(null);
      setPermAsked(true);
    } catch {
      setPermAsked(true);
      setCameraError('Camera access is required.\nPlease allow camera permissions and try again.');
    }
  }, []);

  useEffect(() => {
    startCamera(facing);
    return () => { streamRef.current?.getTracks().forEach(t => t.stop()); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Flip camera ─────────────────────────────────────────────────
  function flipCamera() {
    const next: FacingMode = facing === 'environment' ? 'user' : 'environment';
    setFacing(next);
    startCamera(next);
  }

  // ── Take photo ──────────────────────────────────────────────────
  function takePhoto() {
    const video  = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    canvas.width  = video.videoWidth  || 1280;
    canvas.height = video.videoHeight || 720;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    if (facing === 'user') {
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL('image/jpeg', 0.92);
    const item: CapturedMedia = {
      id:   `p-${Date.now()}`,
      type: 'photo',
      url,
      capturedAt: new Date().toISOString(),
    };
    setMedia(prev => {
      const next = [...prev, item];
      // scroll thumb strip to end
      setTimeout(() => thumbsRef.current?.scrollTo({ left: 99999, behavior: 'smooth' }), 50);
      return next;
    });
    // Flash feedback
    setFlashFx(true);
    setTimeout(() => setFlashFx(false), 120);
  }

  // ── Video recording ─────────────────────────────────────────────
  function toggleRecord() {
    if (isRecording) {
      recorderRef.current?.stop();
      setIsRecording(false);
      setRecSeconds(0);
    } else {
      if (!streamRef.current) return;
      chunksRef.current = [];
      const supported = ['video/webm;codecs=vp9', 'video/webm', 'video/mp4'].find(t =>
        MediaRecorder.isTypeSupported(t)
      ) ?? '';
      const recorder = new MediaRecorder(streamRef.current, supported ? { mimeType: supported } : {});
      recorder.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'video/webm' });
        const url  = URL.createObjectURL(blob);
        // Grab current frame as thumb
        const canvas = canvasRef.current;
        const video  = videoRef.current;
        let thumb: string | undefined;
        if (canvas && video) {
          canvas.width  = 160; canvas.height = 90;
          canvas.getContext('2d')?.drawImage(video, 0, 0, 160, 90);
          thumb = canvas.toDataURL('image/jpeg', 0.7);
        }
        const item: CapturedMedia = { id: `v-${Date.now()}`, type: 'video', url, thumb, capturedAt: new Date().toISOString() };
        setMedia(prev => {
          const next = [...prev, item];
          setTimeout(() => thumbsRef.current?.scrollTo({ left: 99999, behavior: 'smooth' }), 50);
          return next;
        });
      };
      recorder.start(250);
      recorderRef.current = recorder;
      setIsRecording(true);
    }
  }

  // Recording timer
  useEffect(() => {
    if (!isRecording) return;
    const t = setInterval(() => setRecSeconds(s => s + 1), 1000);
    return () => clearInterval(t);
  }, [isRecording]);

  function fmtTime(s: number) {
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  const photoCount = media.filter(m => m.type === 'photo').length;
  const videoCount = media.filter(m => m.type === 'video').length;

  function handleDone() {
    if (isRecording) toggleRecord();
    onClose(media);
  }

  function handleShutter() {
    if (mode === 'photo') takePhoto();
    else toggleRecord();
  }

  function switchMode(m: CaptureMode) {
    if (isRecording) toggleRecord();
    setMode(m);
  }

  // ── Render ──────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col select-none touch-none">
      {/* Hidden canvas for capture */}
      <canvas ref={canvasRef} className="hidden" />

      {/* Viewfinder */}
      <div className="relative flex-1 overflow-hidden bg-black">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="absolute inset-0 w-full h-full object-cover"
          style={{ transform: facing === 'user' ? 'scaleX(-1)' : 'none' }}
        />

        {/* White flash FX */}
        <div
          className="absolute inset-0 bg-white pointer-events-none transition-opacity"
          style={{ opacity: flashFx ? 0.85 : 0, zIndex: 5 }}
        />

        {/* Error / loading state */}
        {permAsked && cameraError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/80 px-8 z-10">
            <ImageIcon size={40} className="text-slate-500" />
            <p className="text-white text-center text-sm whitespace-pre-line">{cameraError}</p>
            <button
              onClick={() => startCamera(facing)}
              className="mt-2 rounded-xl bg-blue-600 px-6 py-2.5 text-sm text-white"
            >
              Try Again
            </button>
          </div>
        )}

        {/* ── Top controls ── */}
        <div
          className="absolute top-0 left-0 right-0 z-10 flex items-center justify-between px-5 pt-5 pb-10"
          style={{ background: 'linear-gradient(to bottom, rgba(0,0,0,0.55) 0%, transparent 100%)' }}
        >
          {/* Close */}
          <button
            onClick={() => { if (isRecording) toggleRecord(); onClose(media); }}
            className="flex size-9 items-center justify-center rounded-full bg-black/30 backdrop-blur-sm hover:bg-black/50 transition-colors"
          >
            <X size={18} className="text-white" />
          </button>

          {/* Recording indicator */}
          {isRecording && (
            <div className="flex items-center gap-2 rounded-full bg-black/40 backdrop-blur-sm px-3 py-1.5">
              <span className="size-2 rounded-full bg-red-500" style={{ animation: 'recDot 1s ease infinite' }} />
              <span className="text-white text-sm tabular-nums">{fmtTime(recSeconds)}</span>
            </div>
          )}

          {/* Media count + flash + flip */}
          <div className="flex items-center gap-2">
            {media.length > 0 && (
              <div className="flex items-center gap-1.5 rounded-full bg-black/30 backdrop-blur-sm px-2.5 py-1.5">
                {photoCount > 0 && <span className="text-white text-xs">{photoCount} 📷</span>}
                {videoCount > 0 && <span className="text-white text-xs">{videoCount} 🎬</span>}
              </div>
            )}
            <button
              onClick={() => setFlashOn(v => !v)}
              className={`flex size-9 items-center justify-center rounded-full transition-colors ${flashOn ? 'bg-yellow-400' : 'bg-black/30 backdrop-blur-sm'}`}
            >
              {flashOn
                ? <Zap size={16} className="text-black" />
                : <ZapOff size={16} className="text-white" />
              }
            </button>
          </div>
        </div>

        {/* Grid overlay (subtle rule-of-thirds) */}
        <div className="absolute inset-0 pointer-events-none z-0 opacity-10">
          {[33, 66].map(p => (
            <div key={p} className="absolute inset-y-0 border-l border-white" style={{ left: `${p}%` }} />
          ))}
          {[33, 66].map(p => (
            <div key={p} className="absolute inset-x-0 border-t border-white" style={{ top: `${p}%` }} />
          ))}
        </div>
      </div>

      {/* ── Bottom controls ── */}
      <div
        className="shrink-0 pb-8 pt-4 px-5 flex flex-col gap-3"
        style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.92) 0%, rgba(0,0,0,0.8) 100%)' }}
      >
        {/* Thumbnail strip */}
        {media.length > 0 && (
          <div
            ref={thumbsRef}
            className="flex gap-2 overflow-x-auto pb-1"
            style={{ scrollbarWidth: 'none' }}
          >
            {media.map((item, i) => (
              <Thumb key={item.id} item={item} index={i} />
            ))}
          </div>
        )}

        {/* Mode selector */}
        <div className="flex justify-center">
          <div className="flex gap-1 rounded-full bg-white/10 p-1">
            {(['photo', 'video'] as CaptureMode[]).map(m => (
              <button
                key={m}
                onClick={() => switchMode(m)}
                className={`flex items-center gap-1.5 rounded-full px-4 py-1.5 text-xs transition-all ${
                  mode === m
                    ? 'bg-white text-slate-900'
                    : 'text-white/70 hover:text-white'
                }`}
              >
                {m === 'photo' ? <Camera size={12} /> : <Video size={12} />}
                {m.charAt(0).toUpperCase() + m.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {/* Main controls row */}
        <div className="flex items-center justify-between px-4">
          {/* Gallery / count */}
          <div className="w-14 flex justify-center">
            {media.length > 0 ? (
              <button
                onClick={handleDone}
                className="relative flex size-14 items-center justify-center rounded-2xl overflow-hidden border-2 border-white/40"
              >
                {media[media.length - 1].type === 'photo'
                  ? <img src={media[media.length - 1].url} className="w-full h-full object-cover" alt="last" />
                  : <div className="w-full h-full bg-slate-700 flex items-center justify-center">
                      <Play size={16} className="text-white" />
                    </div>
                }
                <span
                  className="absolute bottom-0 right-0 left-0 flex items-center justify-center bg-black/50 py-0.5 text-white"
                  style={{ fontSize: 9 }}
                >
                  {media.length}
                </span>
              </button>
            ) : (
              <div className="size-14 rounded-2xl border-2 border-white/20 flex items-center justify-center">
                <ImageIcon size={18} className="text-white/30" />
              </div>
            )}
          </div>

          {/* Shutter */}
          <ShutterButton mode={mode} isRecording={isRecording} onPress={handleShutter} />

          {/* Flip camera */}
          <div className="w-14 flex justify-center">
            <button
              onClick={flipCamera}
              className="flex size-10 items-center justify-center rounded-full bg-white/15 hover:bg-white/25 transition-colors"
            >
              <RotateCcw size={18} className="text-white" />
            </button>
          </div>
        </div>

        {/* Done button */}
        {media.length > 0 && (
          <button
            onClick={handleDone}
            className="mx-auto flex items-center gap-2 rounded-2xl bg-white px-6 py-2.5 text-sm text-slate-900 hover:bg-slate-100 active:scale-95 transition-all"
          >
            <CheckCircle size={15} className="text-green-600" />
            Done
            <span className="text-slate-500">
              {[
                photoCount > 0 && `${photoCount} photo${photoCount > 1 ? 's' : ''}`,
                videoCount > 0 && `${videoCount} video${videoCount > 1 ? 's' : ''}`,
              ].filter(Boolean).join(', ')}
            </span>
            <ChevronRight size={14} className="text-slate-400" />
          </button>
        )}
      </div>

      <style>{`
        @keyframes recDot  { 0%,100%{opacity:1}50%{opacity:0.2} }
        @keyframes recRing { 0%,100%{box-shadow:0 0 0 4px rgba(239,68,68,0.4)}50%{box-shadow:0 0 0 8px rgba(239,68,68,0.15)} }
      `}</style>
    </div>
  );
}

// ─── Camera trigger button (for Shell / pages) ────────────────────
interface CamButtonProps {
  onOpen: () => void;
  variant?: 'topbar' | 'sidebar' | 'inline';
}

export function CameraButton({ onOpen, variant = 'topbar' }: CamButtonProps) {
  if (variant === 'topbar') {
    return (
      <button
        onClick={onOpen}
        className="flex size-8 items-center justify-center rounded-full bg-slate-100 hover:bg-slate-200 transition-colors"
        aria-label="Open camera"
      >
        <Camera size={16} className="text-slate-600" />
      </button>
    );
  }

  if (variant === 'sidebar') {
    return (
      <button
        onClick={onOpen}
        className="flex items-center gap-2.5 w-full rounded-lg px-3 py-2 text-sm text-slate-500 hover:bg-slate-50 hover:text-slate-700 transition-colors"
      >
        <Camera size={16} />
        Camera
      </button>
    );
  }

  // inline (e.g., inside job detail)
  return (
    <button
      onClick={onOpen}
      className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 hover:border-blue-300 hover:bg-blue-50 transition-colors"
    >
      <Camera size={15} className="text-blue-500" />
      Add Photos
    </button>
  );
}