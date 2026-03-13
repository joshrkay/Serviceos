import React, { useState, useCallback } from 'react';
import { Role } from '../../types/conversation';

export interface TranscriptEditorProps {
  originalTranscript: string;
  currentTranscript?: string;
  onSave: (corrected: string) => void;
  onCancel: () => void;
  userRole: Role;
}

export interface TranscriptCorrection {
  originalText: string;
  correctedText: string;
  editedBy: string;
  editedAt: string;
}

export function canEditTranscript(role: Role): boolean {
  return role === 'owner' || role === 'dispatcher';
}

export function validateCorrection(original: string, corrected: string): string | null {
  if (!corrected.trim()) {
    return 'Corrected transcript cannot be empty';
  }
  if (corrected.trim() === original.trim()) {
    return 'No changes detected';
  }
  return null;
}

export function TranscriptEditor({
  originalTranscript,
  currentTranscript,
  onSave,
  onCancel,
  userRole,
}: TranscriptEditorProps) {
  const [text, setText] = useState(currentTranscript ?? originalTranscript);
  const [error, setError] = useState<string | null>(null);

  const isAllowed = canEditTranscript(userRole);

  const handleSave = useCallback(() => {
    const validationError = validateCorrection(originalTranscript, text);
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    onSave(text.trim());
  }, [text, originalTranscript, onSave]);

  if (!isAllowed) {
    return (
      <div className="transcript-editor" data-testid="transcript-editor">
        <div className="transcript-readonly" data-testid="transcript-readonly">
          <p data-testid="transcript-original-text">{originalTranscript}</p>
          <span data-testid="transcript-no-edit-permission">
            You do not have permission to edit transcripts.
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="transcript-editor" data-testid="transcript-editor">
      <div className="transcript-original" data-testid="transcript-original">
        <label>Original:</label>
        <p data-testid="transcript-original-text">{originalTranscript}</p>
      </div>
      <div className="transcript-edit">
        <label>Corrected:</label>
        <textarea
          className="transcript-edit-field"
          data-testid="transcript-edit-field"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (error) setError(null);
          }}
          rows={4}
        />
      </div>
      {error && (
        <span className="transcript-edit-error" data-testid="transcript-edit-error">
          {error}
        </span>
      )}
      <div className="transcript-edit-actions">
        <button data-testid="transcript-save-button" onClick={handleSave}>
          Save
        </button>
        <button data-testid="transcript-cancel-button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
