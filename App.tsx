
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, Modality } from '@google/genai';
import { IdeaSnippet, TranscriptionState } from './types';
import { encodePCM } from './utils/audioUtils';

// Icons as components
const MicrophoneIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
  </svg>
);

const StopIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 10h6v4H9z" />
  </svg>
);

const CopyIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
  </svg>
);

const TrashIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
  </svg>
);

export default function App() {
  const [state, setState] = useState<TranscriptionState>({
    currentText: '',
    history: [],
    isRecording: false,
    status: 'idle',
  });

  const sessionRef = useRef<any>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const transcriptionBuffer = useRef<string>('');
  const historyContainerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll history when new items added
  useEffect(() => {
    if (historyContainerRef.current) {
      historyContainerRef.current.scrollTop = historyContainerRef.current.scrollHeight;
    }
  }, [state.history, state.currentText]);

  const stopListening = useCallback(async () => {
    if (sessionRef.current) {
      sessionRef.current.close?.();
      sessionRef.current = null;
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }

    if (audioContextRef.current) {
      await audioContextRef.current.close();
      audioContextRef.current = null;
    }

    // Move current text to history if it's not empty
    if (transcriptionBuffer.current.trim()) {
      const newSnippet: IdeaSnippet = {
        id: crypto.randomUUID(),
        text: transcriptionBuffer.current.trim(),
        timestamp: new Date(),
      };
      setState(prev => ({
        ...prev,
        history: [...prev.history, newSnippet],
        currentText: '',
        isRecording: false,
        status: 'idle'
      }));
      transcriptionBuffer.current = '';
    } else {
      setState(prev => ({
        ...prev,
        currentText: '',
        isRecording: false,
        status: 'idle'
      }));
    }
  }, []);

  const startListening = async () => {
    try {
      setState(prev => ({ ...prev, status: 'connecting', isRecording: true }));
      
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
      
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      audioContextRef.current = audioContext;

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          systemInstruction: "You are a transcription assistant. Your only job is to provide accurate text of what the user says. Do not respond verbally unless asked. Keep context of ideas.",
        },
        callbacks: {
          onopen: () => {
            setState(prev => ({ ...prev, status: 'listening' }));
            
            const source = audioContext.createMediaStreamSource(stream);
            const scriptProcessor = audioContext.createScriptProcessor(4096, 1, 1);
            
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmData = encodePCM(inputData);
              sessionPromise.then(session => {
                session.sendRealtimeInput({
                  media: { data: pcmData, mimeType: 'audio/pcm;rate=16000' }
                });
              });
            };
            
            source.connect(scriptProcessor);
            scriptProcessor.connect(audioContext.destination);
          },
          onmessage: (message) => {
            if (message.serverContent?.inputTranscription) {
              const text = message.serverContent.inputTranscription.text;
              transcriptionBuffer.current += text;
              setState(prev => ({ ...prev, currentText: transcriptionBuffer.current }));
            }
            
            if (message.serverContent?.turnComplete) {
              // Usually handled by continuous stream, but we can anchor here if needed.
            }
          },
          onerror: (e) => {
            console.error('Gemini error:', e);
            setState(prev => ({ ...prev, status: 'error' }));
            stopListening();
          },
          onclose: () => {
            setState(prev => ({ ...prev, status: 'idle', isRecording: false }));
          }
        }
      });

      sessionRef.current = await sessionPromise;
    } catch (err) {
      console.error('Failed to start listening:', err);
      setState(prev => ({ ...prev, status: 'error', isRecording: false }));
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    // Simple alert-free feedback could be added here
  };

  const clearHistory = () => {
    if (confirm('Clear all captured ideas?')) {
      setState(prev => ({ ...prev, history: [] }));
    }
  };

  const copyAll = () => {
    const allText = state.history.map(h => `[${h.timestamp.toLocaleTimeString()}] ${h.text}`).join('\n\n');
    copyToClipboard(allText);
  };

  return (
    <div className="flex flex-col h-screen max-w-2xl mx-auto px-4 pt-6 pb-24 overflow-hidden bg-slate-900 text-slate-100">
      {/* Header */}
      <header className="flex justify-between items-center mb-6 shrink-0">
        <div>
          <h1 className="text-2xl font-bold bg-gradient-to-r from-blue-400 to-indigo-400 bg-clip-text text-transparent">
            IdeaFlow
          </h1>
          <p className="text-xs text-slate-400">Capture your thoughts hands-free</p>
        </div>
        <div className="flex gap-2">
          {state.history.length > 0 && (
            <>
              <button 
                onClick={copyAll}
                className="p-2 bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors border border-slate-700"
                title="Copy All"
              >
                <CopyIcon />
              </button>
              <button 
                onClick={clearHistory}
                className="p-2 bg-slate-800 hover:bg-red-900/40 rounded-lg transition-colors border border-slate-700 hover:border-red-500/50"
                title="Clear All"
              >
                <TrashIcon />
              </button>
            </>
          )}
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 overflow-y-auto space-y-4 pr-1 scroll-smooth" ref={historyContainerRef}>
        {state.history.length === 0 && !state.isRecording && (
          <div className="h-full flex flex-col items-center justify-center text-center p-8 space-y-4">
            <div className="w-20 h-20 bg-slate-800/50 rounded-full flex items-center justify-center border border-slate-700">
              <MicrophoneIcon />
            </div>
            <h2 className="text-xl font-medium text-slate-300">No ideas yet</h2>
            <p className="text-slate-500 max-w-xs">
              Tap the button below and start speaking. Your ideas will be transcribed in real-time.
            </p>
          </div>
        )}

        {state.history.map((snippet) => (
          <div key={snippet.id} className="group relative bg-slate-800/40 border border-slate-700/50 rounded-2xl p-4 shadow-sm hover:shadow-md transition-shadow">
            <div className="flex justify-between items-start mb-2">
              <span className="text-[10px] font-mono text-slate-500 tracking-wider uppercase">
                {snippet.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
              <button 
                onClick={() => copyToClipboard(snippet.text)}
                className="opacity-0 group-hover:opacity-100 p-1.5 text-slate-400 hover:text-white transition-all"
              >
                <CopyIcon />
              </button>
            </div>
            <p className="text-slate-200 leading-relaxed text-lg font-light">
              {snippet.text}
            </p>
          </div>
        ))}

        {/* Real-time Transcription Placeholder */}
        {state.isRecording && (
          <div className="bg-slate-800/80 border-2 border-dashed border-indigo-500/30 rounded-2xl p-5 shadow-inner">
            <div className="flex items-center gap-2 mb-3">
              <div className="flex gap-1">
                <span className="w-1 h-1 bg-indigo-500 rounded-full animate-bounce" style={{animationDelay: '0ms'}}></span>
                <span className="w-1 h-1 bg-indigo-500 rounded-full animate-bounce" style={{animationDelay: '150ms'}}></span>
                <span className="w-1 h-1 bg-indigo-500 rounded-full animate-bounce" style={{animationDelay: '300ms'}}></span>
              </div>
              <span className="text-[10px] font-bold text-indigo-400 uppercase tracking-widest">Live Transcription</span>
            </div>
            <p className="text-indigo-100 text-lg leading-relaxed animate-pulse">
              {state.currentText || 'Listening for your ideas...'}
            </p>
          </div>
        )}
      </main>

      {/* Floating Controls */}
      <div className="fixed bottom-0 left-0 right-0 p-6 bg-gradient-to-t from-slate-900 via-slate-900 to-transparent pointer-events-none">
        <div className="max-w-2xl mx-auto flex justify-center pointer-events-auto">
          {!state.isRecording ? (
            <button
              onClick={startListening}
              disabled={state.status === 'connecting'}
              className={`
                group relative flex items-center justify-center w-20 h-20 rounded-full bg-indigo-600 hover:bg-indigo-500 shadow-[0_0_30px_rgba(79,70,229,0.3)] hover:shadow-[0_0_40px_rgba(79,70,229,0.5)] transition-all active:scale-95 border-4 border-slate-900
                ${state.status === 'connecting' ? 'opacity-70 cursor-wait' : ''}
              `}
            >
              {state.status === 'connecting' ? (
                <div className="w-8 h-8 border-4 border-white/20 border-t-white rounded-full animate-spin"></div>
              ) : (
                <MicrophoneIcon />
              )}
              <span className="absolute -top-10 scale-0 group-hover:scale-100 transition-transform bg-slate-800 text-white text-xs py-1 px-3 rounded-full border border-slate-700">
                Start Recording
              </span>
            </button>
          ) : (
            <button
              onClick={stopListening}
              className="group flex items-center justify-center w-20 h-20 rounded-full bg-red-600 hover:bg-red-500 shadow-[0_0_30px_rgba(220,38,38,0.3)] transition-all active:scale-95 border-4 border-slate-900 pulse-animation"
            >
              <StopIcon />
              <span className="absolute -top-10 transition-transform bg-slate-800 text-white text-xs py-1 px-3 rounded-full border border-slate-700">
                Stop & Save
              </span>
            </button>
          )}
        </div>
      </div>

      {/* Error Toast */}
      {state.status === 'error' && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 bg-red-500/90 text-white px-4 py-2 rounded-full text-sm font-medium shadow-lg backdrop-blur-sm z-50">
          Error connecting to transcription service.
        </div>
      )}
    </div>
  );
}
