import { useState, useRef, useEffect } from 'react';
import { FileText, Camera, Mic, X, Send, Square, Check, AlertCircle } from 'lucide-react';
import { SheetOverlay } from './JobSheets';
import { Textarea } from '../ui';
import { CameraCapture } from '../shared/CameraCapture';
import type { JobActivity } from '../../data/mock-data';
import type { CapturedMedia } from '../shared/CameraCapture';

type EntryMode = 'note' | 'photo' | 'voice';

const NOTE_TAGS = ['General', 'Issue', 'Customer Request', 'Safety', 'Material', 'Follow-up'];

// D2: Removed fabricated MOCK_TRANSCRIPTS — voice notes now show honest empty state
// until real transcription pipeline is integrated

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

  // D2: Voice transcription shows honest "coming soon" state instead of fake transcripts
  function stopRecording() {
    setRecording(false);
    // Voice transcription pipeline not yet integrated — show coming soon state
    setTranscribing(false);
    setTranscript('');
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
      {/* D2: Voice tab shows honest "coming soon" state — transcription pipeline not yet integrated */}
      {mode === 'voice' && (
        <div className="flex flex-col items-center gap-4">
          <div className="flex flex-col items-center gap-4 py-6">
            <div className="size-16 rounded-full bg-secondary flex items-center justify-center">
              <Mic size={28} className="text-muted-foreground" />
            </div>
            <div className="text-center">
              <p className="text-sm text-foreground mb-1">Voice notes coming soon</p>
              <p className="text-xs text-muted-foreground max-w-[260px]">
                We're integrating real-time transcription. For now, use the Note tab to add field observations.
              </p>
            </div>
            <button
              onClick={() => setMode('note')}
              className="flex items-center gap-2 rounded-xl border border-border px-4 py-2.5 text-sm text-foreground hover:bg-secondary transition-colors"
            >
              <FileText size={14} /> Switch to Note
            </button>
          </div>
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
