import { useState, useRef, useEffect } from 'react';
import { FileText, Camera, Mic, X, Send, Square, Check } from 'lucide-react';
import { SheetOverlay } from './JobSheets';
import { Textarea } from '../ui';
import { CameraCapture } from '../shared/CameraCapture';
import type { JobActivity } from '../../data/mock-data';
import type { CapturedMedia } from '../shared/CameraCapture';

type EntryMode = 'note' | 'photo' | 'voice';

const NOTE_TAGS = ['General', 'Issue', 'Customer Request', 'Safety', 'Material', 'Follow-up'];

const MOCK_TRANSCRIPTS = [
  '"Ran into an issue with the supply line pressure — it\'s running at 80 PSI instead of the normal 60. Installed a pressure reducer and now it\'s stable."',
  '"Customer approved the additional work on the secondary unit. Total scope is expanding — I\'ll update the estimate before leaving."',
  '"Job took longer than expected due to access issues in the crawl space. Needed to cut a 12-inch inspection hole. Customer aware and signed off."',
];

interface Props {
  author: string;
  authorInitials: string;
  authorColor: string;
  onClose: () => void;
  onSubmit: (entry: Partial<JobActivity>) => void;
}

export function AddEntrySheet({ author, authorInitials, authorColor, onClose, onSubmit }: Props) {
  const [mode, setMode] = useState<EntryMode>('note');

  // Note state
  const [noteText, setNoteText]   = useState('');
  const [noteTags, setNoteTags]   = useState<string[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Photo state
  const [cameraOpen, setCameraOpen]     = useState(false);
  const [captured, setCaptured]         = useState<CapturedMedia[]>([]);

  // Voice state
  const [recording, setRecording]       = useState(false);
  const [recSeconds, setRecSeconds]     = useState(0);
  const [transcribing, setTranscribing] = useState(false);
  const [transcript, setTranscript]     = useState('');

  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => setRecSeconds(s => s + 1), 1000);
    return () => clearInterval(t);
  }, [recording]);

  function stopRecording() {
    setRecording(false);
    setTranscribing(true);
    setTimeout(() => {
      setTranscribing(false);
      setTranscript(MOCK_TRANSCRIPTS[Math.floor(Math.random() * MOCK_TRANSCRIPTS.length)]);
    }, 1600);
  }

  function fmt(s: number) {
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  function toggleTag(tag: string) {
    setNoteTags(prev => prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]);
  }

  function handleSubmit() {
    const time = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (mode === 'note') {
      if (!noteText.trim()) return;
      onSubmit({
        type: 'note',
        content: noteText.trim(),
        author, authorInitials, authorColor,
        time,
      });
    } else if (mode === 'photo') {
      if (captured.length === 0) return;
      onSubmit({
        type: 'photo',
        content: `${captured.length} photo${captured.length > 1 ? 's' : ''} added`,
        author, authorInitials, authorColor,
        time,
      });
    } else if (mode === 'voice') {
      if (!transcript) return;
      onSubmit({
        type: 'voice',
        content: transcript,
        author, authorInitials, authorColor,
        time,
        voiceDuration: recSeconds || 18,
      });
    }
    onClose();
  }

  if (cameraOpen) {
    return (
      <CameraCapture
        onClose={media => {
          if (media.length > 0) setCaptured(prev => [...prev, ...media]);
          setCameraOpen(false);
        }}
      />
    );
  }

  const canSubmit =
    (mode === 'note' && noteText.trim().length > 0) ||
    (mode === 'photo' && captured.length > 0) ||
    (mode === 'voice' && transcript.length > 0);

  return (
    <SheetOverlay onClose={onClose}>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-foreground">Add Entry</p>
        <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-secondary">
          <X size={16} className="text-muted-foreground" />
        </button>
      </div>

      {/* Mode tabs */}
      <div className="flex gap-1 rounded-xl bg-secondary p-1 mb-5">
        {([
          { key: 'note',  label: 'Note',  icon: FileText },
          { key: 'photo', label: 'Photo', icon: Camera },
          { key: 'voice', label: 'Voice', icon: Mic },
        ] as { key: EntryMode; label: string; icon: React.ElementType }[]).map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setMode(key)}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg py-2 text-xs transition-all ${
              mode === key ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <Icon size={13} /> {label}
          </button>
        ))}
      </div>

      {/* ── Note tab ── */}
      {mode === 'note' && (
        <div className="flex flex-col gap-3">
          <Textarea
            ref={textareaRef}
            autoFocus
            value={noteText}
            onChange={e => setNoteText(e.target.value)}
            placeholder="What happened on site? Describe the issue, work done, or observations…"
            rows={5}
            className="min-h-11 resize-none"
          />
          <div>
            <p className="text-xs text-muted-foreground mb-2">Tag this note</p>
            <div className="flex flex-wrap gap-1.5">
              {NOTE_TAGS.map(tag => (
                <button
                  key={tag}
                  onClick={() => toggleTag(tag)}
                  className={`rounded-full px-2.5 py-1 text-xs transition-colors ${
                    noteTags.includes(tag)
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-secondary text-foreground hover:bg-border'
                  }`}
                >
                  {tag}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Photo tab ── */}
      {mode === 'photo' && (
        <div className="flex flex-col gap-3">
          {captured.length > 0 ? (
            <>
              <div className="grid grid-cols-3 gap-2">
                {captured.map((item, i) => (
                  <div key={item.id} className="relative aspect-square rounded-xl overflow-hidden bg-secondary">
                    {item.type === 'photo' ? (
                      <img src={item.url} className="w-full h-full object-cover" alt={`capture ${i + 1}`} />
                    ) : (
                      <div className="w-full h-full bg-primary flex items-center justify-center">
                        <span className="text-primary-foreground text-xs">Video</span>
                      </div>
                    )}
                  </div>
                ))}
                <button
                  onClick={() => setCameraOpen(true)}
                  className="aspect-square rounded-xl border-2 border-dashed border-border flex items-center justify-center hover:border-primary/30 hover:bg-primary/10 transition-colors"
                >
                  <Camera size={18} className="text-muted-foreground" />
                </button>
              </div>
              <p className="text-xs text-muted-foreground text-center">{captured.length} item{captured.length > 1 ? 's' : ''} ready to attach</p>
            </>
          ) : (
            <button
              onClick={() => setCameraOpen(true)}
              className="flex flex-col items-center gap-4 rounded-2xl border-2 border-dashed border-border py-10 hover:border-primary/30 hover:bg-primary/10 transition-colors"
            >
              <span className="flex size-14 items-center justify-center rounded-full bg-secondary">
                <Camera size={22} className="text-muted-foreground" />
              </span>
              <div className="text-center">
                <p className="text-sm text-foreground">Open camera</p>
                <p className="text-xs text-muted-foreground mt-0.5">Take photos or record video</p>
              </div>
            </button>
          )}
        </div>
      )}

      {/* ── Voice tab ── */}
      {mode === 'voice' && (
        <div className="flex flex-col items-center gap-4">
          {!recording && !transcribing && !transcript && (
            <>
              <div className="flex flex-col items-center gap-3 py-4">
                <p className="text-sm text-muted-foreground text-center">Tap to start recording your voice note</p>
                <button
                  onClick={() => { setRecording(true); setRecSeconds(0); }}
                  className="flex size-20 items-center justify-center rounded-full bg-primary hover:bg-primary active:scale-95 transition-all shadow-lg"
                >
                  <Mic size={30} className="text-primary-foreground" />
                </button>
              </div>
            </>
          )}

          {recording && (
            <div className="flex flex-col items-center gap-4 py-4 w-full">
              <div className="flex items-center gap-2">
                <span className="size-2 rounded-full bg-destructive" style={{ animation: 'recDot 1s ease infinite' }} />
                <span className="text-sm text-foreground tabular-nums">{fmt(recSeconds)}</span>
              </div>
              {/* Waveform bars */}
              <div className="flex items-center gap-1 h-10">
                {Array.from({ length: 20 }).map((_, i) => (
                  <div
                    key={i}
                    className="w-1 rounded-full bg-primary"
                    style={{
                      height: `${20 + Math.random() * 60}%`,
                      animation: `wave 0.${6 + (i % 4)}s ease-in-out ${i * 0.05}s infinite alternate`,
                    }}
                  />
                ))}
              </div>
              <button
                onClick={stopRecording}
                className="flex size-16 items-center justify-center rounded-full bg-destructive hover:bg-destructive active:scale-95 transition-all"
              >
                <Square size={18} className="text-primary-foreground fill-current" />
              </button>
              <p className="text-xs text-muted-foreground">Tap to stop recording</p>
            </div>
          )}

          {transcribing && (
            <div className="flex flex-col items-center gap-3 py-8">
              <div className="size-10 rounded-full bg-primary/15 flex items-center justify-center">
                <Mic size={18} className="text-primary" />
              </div>
              <p className="text-sm text-muted-foreground">Transcribing…</p>
              <div className="flex gap-1">
                {[0, 1, 2].map(i => (
                  <span key={i} className="size-1.5 rounded-full bg-primary"
                    style={{ animation: `recDot 0.8s ease-in-out ${i * 0.2}s infinite` }} />
                ))}
              </div>
            </div>
          )}

          {transcript && (
            <div className="w-full">
              <div className="flex items-center gap-2 mb-2">
                <Mic size={13} className="text-primary" />
                <span className="text-xs text-primary">Transcript</span>
                <span className="text-xs text-muted-foreground ml-auto">{recSeconds || 18}s</span>
              </div>
              <div className="rounded-xl bg-primary/10 border border-primary/20 px-3 py-3 mb-3">
                <p className="text-sm text-foreground italic">{transcript}</p>
              </div>
              <button
                onClick={() => { setTranscript(''); setRecSeconds(0); }}
                className="text-xs text-muted-foreground hover:text-foreground underline"
              >
                Re-record
              </button>
            </div>
          )}
        </div>
      )}

      {/* Submit */}
      <div className="mt-5">
        <button
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="flex items-center justify-center gap-2 w-full py-3 rounded-xl bg-primary text-primary-foreground text-sm hover:bg-primary/90 transition-colors disabled:opacity-30"
        >
          <Send size={14} /> Add to timeline
        </button>
      </div>

      <style>{`
        @keyframes recDot { 0%,100%{opacity:1} 50%{opacity:0.2} }
        @keyframes wave { from { transform: scaleY(0.4); } to { transform: scaleY(1); } }
      `}</style>
    </SheetOverlay>
  );
}
