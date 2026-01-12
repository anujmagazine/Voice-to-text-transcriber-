
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, Modality } from '@google/genai';
import { IdeaSnippet, TranscriptionState } from './types';
import { encodePCM } from './utils/audioUtils';

// Constants
const SAMPLE_RATE = 16000;
const BUFFER_SIZE = 4096;

export default function App() {
  const [state, setState] = useState<TranscriptionState>({
    currentText: '',
    history: [],
    isRecording: false,
    status: 'idle',
  });
  
  const [toast, setToast] = useState<string | null>(null);
  const [voulmeLevel, setVolumeLevel] = useState(0);

  // Refs for non-reactive state
  const sessionRef = useRef<any>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const historyContainerRef = useRef<HTMLDivElement>(null);
  
  // Accumulated transcription refs
  const currentTurnText = useRef<string>('');
  const lastFinalizedText = useRef<string>('');

  // Auto-scroll when transcription updates
  useEffect(() => {
    if (historyContainerRef.current) {
      historyContainerRef.current.scrollTop = historyContainerRef.current.scrollHeight;
    }
  }, [state.history, state.currentText]);

  const cleanup = useCallback(async () => {
    if (sessionRef.current) {
      try { sessionRef.current.close(); } catch (e) {}
      sessionRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (audioContextRef.current) {
      try { await audioContextRef.current.close(); } catch (e) {}
      audioContextRef.current = null;
    }
    setVolumeLevel(0);
  }, []);

  const stopSession = useCallback(async () => {
    // Save current buffer if exists
    if (currentTurnText.current.trim()) {
      const newSnippet: IdeaSnippet = {
        id: crypto.randomUUID(),
        text: currentTurnText.current.trim(),
        timestamp: new Date(),
      };
      setState(prev => ({
        ...prev,
        history: [...prev.history, newSnippet],
        currentText: '',
        isRecording: false,
        status: 'idle'
      }));
    } else {
      setState(prev => ({ ...prev, currentText: '', isRecording: false, status: 'idle' }));
    }
    
    currentTurnText.current = '';
    lastFinalizedText.current = '';
    await cleanup();
  }, [cleanup]);

  const startSession = async () => {
    try {
      setState(prev => ({ ...prev, status: 'connecting', isRecording: true, currentText: '' }));
      currentTurnText.current = '';
      lastFinalizedText.current = '';

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
      
      // 1. Get Microphone Access
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // 2. Setup Audio Context
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: SAMPLE_RATE });
      audioContextRef.current = audioContext;

      // 3. Connect to Gemini Live API
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          systemInstruction: "You are a specialized transcription service. \n\nRULES:\n1. Transcribe the user's audio into English text ONLY.\n2. Do NOT use any other language or script (No Hindi).\n3. If you hear non-English, attempt to transcribe it phonetically in English.\n4. Provide verbatim transcription. No summaries, no conversational filler.\n5. Output text immediately as it is recognized.",
        },
        callbacks: {
          onopen: () => {
            setState(prev => ({ ...prev, status: 'listening' }));
            
            const source = audioContext.createMediaStreamSource(stream);
            const scriptProcessor = audioContext.createScriptProcessor(BUFFER_SIZE, 1, 1);
            
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              
              // Simple volume analysis for the visualizer
              let sum = 0;
              for(let i=0; i<inputData.length; i++) sum += inputData[i] * inputData[i];
              setVolumeLevel(Math.sqrt(sum / inputData.length));

              const pcmData = encodePCM(inputData);
              sessionPromise.then(session => {
                session.sendRealtimeInput({
                  media: { data: pcmData, mimeType: 'audio/pcm;rate=16000' }
                });
              });
            };
            
            source.connect(scriptProcessor);
            scriptProcessor.connect(audioContext.destination);
            
            if (audioContext.state === 'suspended') audioContext.resume();
          },
          onmessage: (message: any) => {
            // Real-time transcription segment
            if (message.serverContent?.inputTranscription) {
              const textDelta = message.serverContent.inputTranscription.text;
              currentTurnText.current += textDelta;
              setState(prev => ({ ...prev, currentText: currentTurnText.current }));
            }
            
            // Turn completion detection (natural pause)
            if (message.serverContent?.turnComplete) {
              if (currentTurnText.current.trim()) {
                const textToSave = currentTurnText.current.trim();
                setState(prev => ({
                  ...prev,
                  history: [...prev.history, {
                    id: crypto.randomUUID(),
                    text: textToSave,
                    timestamp: new Date(),
                  }],
                  currentText: ''
                }));
                currentTurnText.current = '';
              }
            }
          },
          onerror: (e) => {
            console.error('Gemini Live API Error:', e);
            setState(prev => ({ ...prev, status: 'error' }));
            stopSession();
          },
          onclose: () => {
            setState(prev => ({ ...prev, status: 'idle', isRecording: false }));
          }
        }
      });

      sessionRef.current = await sessionPromise;
    } catch (err) {
      console.error('Initialization Error:', err);
      setState(prev => ({ ...prev, status: 'error', isRecording: false }));
      cleanup();
    }
  };

  const copyText = (text: string) => {
    navigator.clipboard.writeText(text);
    setToast('Copied');
    setTimeout(() => setToast(null), 2000);
  };

  return (
    <div className="flex flex-col h-screen max-w-2xl mx-auto px-4 pt-6 pb-24 overflow-hidden bg-[#0a0a0c] text-slate-100 font-sans">
      {/* Header */}
      <header className="flex justify-between items-center mb-8 shrink-0">
        <div>
          <h1 className="text-3xl font-black tracking-tighter text-white">
            IDEA<span className="text-indigo-500">FLOW</span>
          </h1>
          <div className="flex items-center gap-2 mt-1">
            <span className={`w-2 h-2 rounded-full ${state.isRecording ? 'bg-green-500 animate-pulse' : 'bg-slate-700'}`}></span>
            <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">
              {state.status === 'listening' ? 'Streaming Audio (English)' : state.status === 'connecting' ? 'Connecting...' : 'Mic Ready'}
            </span>
          </div>
        </div>
        {state.history.length > 0 && (
          <button 
            onClick={() => { if(confirm('Clear history?')) setState(prev => ({ ...prev, history: [] })) }}
            className="p-2 text-slate-600 hover:text-red-500 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
          </button>
        )}
      </header>

      {/* Main Stream */}
      <main className="flex-1 overflow-y-auto space-y-6 pr-2 scroll-smooth" ref={historyContainerRef}>
        {state.history.length === 0 && !state.isRecording && (
          <div className="h-full flex flex-col items-center justify-center text-center opacity-30">
            <div className="w-20 h-20 mb-6 flex items-center justify-center rounded-full border border-slate-700">
              <svg className="w-10 h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>
            </div>
            <p className="text-sm tracking-wide">Capture ideas hands-free while driving</p>
          </div>
        )}

        {/* Saved History */}
        {state.history.map((snippet) => (
          <div key={snippet.id} className="relative bg-[#151518] border border-slate-800/60 rounded-3xl p-6 group transition-all hover:border-slate-700">
            <div className="flex items-center justify-between mb-4">
              <span className="text-[10px] font-mono text-slate-500 uppercase">{snippet.timestamp.toLocaleTimeString()}</span>
              <button onClick={() => copyText(snippet.text)} className="opacity-0 group-hover:opacity-100 p-2 bg-slate-800 rounded-full text-slate-400 hover:text-white transition-all">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" /></svg>
              </button>
            </div>
            <p className="text-slate-200 text-xl font-light leading-relaxed tracking-tight">{snippet.text}</p>
          </div>
        ))}

        {/* Active Transcription */}
        {state.isRecording && (
          <div className="bg-indigo-600/5 border border-indigo-500/30 rounded-3xl p-6 relative overflow-hidden transition-all shadow-[0_0_30px_rgba(79,70,229,0.1)]">
            <div className="flex items-center gap-3 mb-4">
              <div className="flex items-center gap-0.5 h-3">
                {[...Array(4)].map((_, i) => (
                  <div key={i} className="w-1 bg-indigo-500 rounded-full" style={{ height: `${20 + (voulmeLevel * (200 + i * 50))}%` }} />
                ))}
              </div>
              <span className="text-[10px] font-black text-indigo-400 uppercase tracking-widest">Listening</span>
            </div>
            <p className="text-white text-2xl font-medium leading-snug">
              {state.currentText || <span className="opacity-30 italic">Start speaking your thoughts...</span>}
            </p>
          </div>
        )}
      </main>

      {/* Controls */}
      <div className="fixed bottom-0 left-0 right-0 p-8 flex justify-center bg-gradient-to-t from-[#0a0a0c] via-[#0a0a0c] to-transparent pointer-events-none">
        <div className="relative pointer-events-auto">
          {!state.isRecording ? (
            <button
              onClick={startSession}
              disabled={state.status === 'connecting'}
              className="w-24 h-24 rounded-full bg-white text-black flex items-center justify-center shadow-2xl active:scale-90 transition-all border-[6px] border-[#0a0a0c] disabled:opacity-50"
            >
              <svg className="w-10 h-10" fill="currentColor" viewBox="0 0 24 24"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/><path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>
            </button>
          ) : (
            <button
              onClick={stopSession}
              className="w-24 h-24 rounded-full bg-red-600 text-white flex items-center justify-center shadow-[0_0_40px_rgba(220,38,38,0.4)] active:scale-90 transition-all border-[6px] border-[#0a0a0c]"
            >
              <svg className="w-10 h-10" fill="currentColor" viewBox="0 0 24 24"><path d="M6 6h12v12H6z"/></svg>
            </button>
          )}
          
          {/* External Pulse Ring */}
          {state.isRecording && (
             <div className="absolute -inset-4 rounded-full border-2 border-indigo-500/20 animate-ping pointer-events-none" />
          )}
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div className="fixed top-8 left-1/2 -translate-x-1/2 bg-white text-black px-6 py-2 rounded-full text-xs font-bold shadow-2xl z-50 transition-all">
          {toast}
        </div>
      )}

      {/* Error State */}
      {state.status === 'error' && (
        <div className="fixed top-0 left-0 right-0 p-3 bg-red-600 text-white text-[10px] font-bold text-center uppercase tracking-widest">
          Microphone or connection error. Please refresh.
        </div>
      )}
    </div>
  );
}
