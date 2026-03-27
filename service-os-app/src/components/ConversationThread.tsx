'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Sparkles, Loader2 } from 'lucide-react';
import MessageInput from './MessageInput';
import MicButton from './MicButton';
import ProposalCard, { type Proposal } from './ProposalCard';

interface Message {
  id: string;
  role: 'contractor' | 'assistant';
  content: string;
  timestamp: string;
  inputMethod?: 'text' | 'voice';
  proposal?: Proposal;
}

const EXAMPLES = [
  'Charge Johnson 420 for garbage disposal',
  "What's on my schedule today?",
  'Add a new customer',
];

export default function ConversationThread() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, isLoading]);

  const sendMessage = useCallback(async (text: string, inputMethod: 'text' | 'voice' = 'text') => {
    const contractorMsg: Message = {
      id: crypto.randomUUID(),
      role: 'contractor',
      content: text,
      timestamp: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
      inputMethod,
    };
    setMessages(prev => [...prev, contractorMsg]);
    setIsLoading(true);

    try {
      const res = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript: text, input_method: inputMethod }),
      });

      if (!res.ok) throw new Error(`API error: ${res.status}`);
      const data = await res.json();

      const assistantMsg: Message = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: data.confirmation_message || data.clarification_question || 'Got it.',
        timestamp: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
        proposal: data.clarification_needed ? undefined : data,
      };
      setMessages(prev => [...prev, assistantMsg]);
    } catch {
      setMessages(prev => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: 'Something went wrong. Try again.',
          timestamp: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  function handleVoiceResult(transcript: string) {
    setInterimTranscript('');
    if (transcript.trim()) {
      sendMessage(transcript, 'voice');
    }
  }

  // Welcome screen
  if (messages.length === 0 && !isLoading) {
    return (
      <div className="flex-1 flex flex-col">
        <div className="flex-1 flex flex-col items-center justify-center px-6 gap-6">
          <div className="size-14 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shadow-lg">
            <Sparkles size={24} className="text-white" />
          </div>
          <div className="text-center">
            <h2 className="text-lg font-semibold text-slate-800">Hi! I&apos;m your AI assistant.</h2>
            <p className="text-sm text-slate-500 mt-1">
              I can create invoices, schedule jobs, and manage your customers.
            </p>
          </div>
          <div className="w-full space-y-2">
            {EXAMPLES.map(text => (
              <button
                key={text}
                onClick={() => sendMessage(text)}
                className="w-full text-left text-sm px-4 py-3 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 transition-colors text-slate-700"
              >
                &ldquo;{text}&rdquo;
              </button>
            ))}
          </div>
        </div>
        <MessageInput
          onSend={text => sendMessage(text)}
          micButton={
            <MicButton
              onTranscript={handleVoiceResult}
              onInterim={setInterimTranscript}
            />
          }
          interimTranscript={interimTranscript}
        />
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col">
      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-4 space-y-3">
        {messages.map(msg => (
          <div key={msg.id}>
            {msg.role === 'contractor' ? (
              /* Contractor — right-aligned dark bubble */
              <div className="flex justify-end">
                <div className="max-w-[80%]">
                  <div className="bg-blue-600 text-white rounded-2xl rounded-br-sm px-3.5 py-2.5 shadow-sm">
                    <p className="text-sm">{msg.content}</p>
                  </div>
                  <p className="text-xs text-slate-400 text-right mt-0.5 mr-1">{msg.timestamp}</p>
                </div>
              </div>
            ) : (
              /* Assistant — left-aligned light bubble + optional proposal card */
              <div className="flex gap-2">
                <span className="size-6 shrink-0 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center mt-0.5">
                  <Sparkles size={12} className="text-white" />
                </span>
                <div className="max-w-[85%] space-y-2">
                  <div className="bg-white border border-slate-200 rounded-2xl rounded-tl-sm px-3.5 py-2.5 shadow-sm">
                    <p className="text-sm text-slate-700">{msg.content}</p>
                  </div>
                  {msg.proposal && (
                    <ProposalCard
                      proposal={msg.proposal}
                      onApprove={() => console.log('approve', msg.proposal)}
                      onEdit={() => console.log('edit', msg.proposal)}
                    />
                  )}
                  <p className="text-xs text-slate-400 ml-1">{msg.timestamp}</p>
                </div>
              </div>
            )}
          </div>
        ))}

        {/* Typing indicator */}
        {isLoading && (
          <div className="flex gap-2">
            <span className="size-6 shrink-0 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center">
              <Sparkles size={12} className="text-white" />
            </span>
            <div className="bg-white border border-slate-200 rounded-2xl rounded-tl-sm px-4 py-3 shadow-sm">
              <Loader2 size={16} className="text-slate-400 animate-spin" />
            </div>
          </div>
        )}
      </div>

      {/* Input */}
      <MessageInput
        onSend={text => sendMessage(text)}
        disabled={isLoading}
        micButton={
          <MicButton
            onTranscript={handleVoiceResult}
            onInterim={setInterimTranscript}
            disabled={isLoading}
          />
        }
        interimTranscript={interimTranscript}
      />
    </div>
  );
}
