
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, Modality } from '@google/genai';
import { IdeaSnippet, TranscriptionState } from './types';
import { encodePCM } from './utils/audioUtils';

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
  const [volume, setVolume] = useState(0);

  // Core References
  const sessionPromiseRef = useRef<Promise<any> | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const historyContainerRef = useRef<HTMLDivElement>(null);
  
  // Transcription Buffer (Ref for immediate access)
  const currentTranscriptionRef = useRef<string>('');

  // Auto-scroll logic
  useEffect(() => {
    if (historyContainerRef.current) {
      historyContainerRef.current.scrollTo({
        top: historyContainerRef.current.scrollHeight,
        behavior: 'smooth'
      });
    }
  }, [state.history, state.currentText]);

  const cleanup = useCallback(async () => {
    sessionPromiseRef.current = null;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (audioContextRef.current) {
      try { await audioContextRef.current.close(); } catch (e) {}
      audioContextRef.current = null;
    }
    setVolume(0);
  }, []);

  const finalizeTurn = useCallback(() => {
    const text = currentTranscriptionRef.current.trim();
    if (text.length > 2) {
      const snippet: IdeaSnippet = {
        id: crypto.randomUUID(),
        text: text,
        timestamp: new Date(),
      };
      setState(prev => ({
        ...prev,
        history: [...prev.history, snippet],
        currentText: ''
      }));
    }
    currentTranscriptionRef.current = '';
    setState(prev => ({ ...prev, currentText: '' }));
  }, []);

  const stopSession = useCallback(async () => {
    finalizeTurn();
    setState(prev => ({ ...prev, isRecording: false, status: 'idle' }));
    await cleanup();
  }, [cleanup, finalizeTurn]);

  const startSession = async () => {
    try {
      setState(prev => ({ ...prev, status: 'connecting', isRecording: true, currentText: '' }));
      currentTranscriptionRef.current = '';

      // 1. Setup Audio Input
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: { 
          echoCancellation: true, 
          noiseSuppression: true, 
          autoGainControl: true 
        } 
      });
      streamRef.current = stream;

      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: SAMPLE_RATE });
      audioContextRef.current = audioContext;

      // 2. Initialize Gemini Live API
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
      
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          systemInstruction: `
            SYSTEM COMMAND: You are a high-speed speech-to-text machine.
            LANGUAGE: ENGLISH ONLY.
            CONSTRAINT: NO HINDI. NO SPANISH. NO OTHER LANGUAGES.
            ACTION: If audio is Hindi, ignore it. Output ONLY English text chunks.
            NO DIALOGUE: Do not talk back. Do not summarize. Just verbatim text.
            LATENCY: Output text chunks immediately.
          `,
        },
        callbacks: {
          onopen: () => {
            setState(prev => ({ ...prev, status: 'listening' }));
            
            // 3. Start Audio Processor ONLY after connection is open
            const source = audioContext.createMediaStreamSource(stream);
            const processor = audioContext.createScriptProcessor(BUFFER_SIZE, 1, 1);
            
            processor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              
              // Visual Feedback (Volume Meter)
              let sum = 0;
              for (let i = 0; i < inputData.length; i++) sum += inputData[i] * inputData[i];
              setVolume(Math.sqrt(sum / inputData.length));

              // SEND AUDIO IMMEDIATELY (Rely on sessionPromise)
              sessionPromise.then(session => {
                const pcmBase64 = encodePCM(inputData);
                session.sendRealtimeInput({
                  media: { data: pcmBase64, mimeType: 'audio/pcm;rate=16000' }
                });
              });
            };
            
            source.connect(processor);
            processor.connect(audioContext.destination);
            if (audioContext.state === 'suspended') audioContext.resume();
          },
          onmessage: (msg: any) => {
            // Handle Live Text Streaming
            const textDelta = msg.serverContent?.inputTranscription?.text;
            if (textDelta) {
              currentTranscriptionRef.current += textDelta;
              setState(prev => ({ ...prev, currentText: currentTranscriptionRef.current }));
            }
            
            // Handle Pause/Turn End
            if (msg.serverContent?.turnComplete) {
              finalizeTurn();
            }
          },
          onerror: (err) => {
            console.error('Session Error:', err);
            setState(prev => ({ ...prev, status: 'error' }));
            stopSession();
          },
          onclose: () => {
            setState(prev => ({ ...prev, isRecording: false, status: 'idle' }));
          }
        }
      });

      sessionPromiseRef.current = sessionPromise;
    } catch (err) {
      console.error('App Failed:', err);
      setState(prev => ({ ...prev, status: 'error', isRecording: false }));
      cleanup();
    }
  };

  const copy = (text: string) => {
    navigator.clipboard.writeText(text);
    setToast('COPIED');
    setTimeout(() => setToast(null), 1500);
  };

  return (
    <div className="flex flex-col h-screen max-w-xl mx-auto bg-black text-white font-sans overflow-hidden">
      {/* Dynamic Header */}
      <header className="p-6 shrink-0 flex justify-between items-center border-b border-white/10 bg-black/80 backdrop-blur-xl z-20">
        <div>
          <h1 className="text-2xl font-black italic tracking-tighter">
            IDEA<span className="text-blue-500">FLOW</span>
          </h1>
          <div className="flex items-center gap-2 mt-1">
            <div className={`w-2 h-2 rounded-full ${state.isRecording ? 'bg-red-500 animate-pulse' : 'bg-white/20'}`} />
            <span className="text-[10px] font-bold text-white/40 uppercase tracking-widest">
              {state.status === 'listening' ? 'Native Stream Active' : state.status === 'connecting' ? 'Linking Engine' : 'Hands-Free Ready'}
            </span>
          </div>
        </div>
        {state.history.length > 0 && (
          <button 
            onClick={() => confirm('Clear history?') && setState(prev => ({ ...prev, history: [] }))}
            className="p-3 bg-white/5 rounded-xl text-white/40 hover:text-red-500 transition-colors border border-white/5"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
          </button>
        )}
      </header>

      {/* Main Experience */}
      <main className="flex-1 overflow-y-auto px-6 py-8 space-y-6 scrollbar-hide" ref={historyContainerRef}>
        {state.history.length === 0 && !state.isRecording && (
          <div className="h-full flex flex-col items-center justify-center text-center opacity-30">
            <div className="w-24 h-24 mb-6 flex items-center justify-center rounded-full border-2 border-dashed border-white/20">
              <svg className="w-10 h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 18.5a6.5 6.5 0 100-13 6.5 6.5 0 000 13zM12 18.5v4m-3.5-4l3.5 4 3.5-4" /></svg>
            </div>
            <p className="text-sm font-medium">Tap the button and start speaking your ideas.</p>
          </div>
        )}

        {/* History of Captured Thoughts */}
        {state.history.map((snippet) => (
          <div key={snippet.id} className="animate-in fade-in slide-in-from-bottom-2">
            <div className="bg-[#0f0f12] border border-white/5 rounded-[2rem] p-7 transition-all hover:bg-[#16161a] relative group">
              <div className="flex justify-between items-start mb-4">
                <span className="text-[10px] font-black text-blue-500/50 bg-blue-500/5 px-3 py-1 rounded-lg uppercase">
                  {snippet.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
                <button onClick={() => copy(snippet.text)} className="p-2 text-white/20 hover:text-white transition-colors">
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" /></svg>
                </button>
              </div>
              <p className="text-white/90 text-2xl font-light leading-snug">
                {snippet.text}
              </p>
            </div>
          </div>
        ))}

        {/* Live Active Buffer */}
        {state.isRecording && (
          <div className="bg-blue-600/10 border-2 border-blue-500/30 rounded-[2.5rem] p-10 relative overflow-hidden shadow-2xl animate-in zoom-in-95 duration-200">
            <div className="flex items-center gap-4 mb-8">
              <div className="flex items-end gap-1 h-6">
                {[...Array(6)].map((_, i) => (
                  <div 
                    key={i} 
                    className="w-1.5 bg-blue-500 rounded-full transition-all duration-75"
                    style={{ height: `${20 + (volume * (400 + i * 150))}%`, opacity: 0.3 + (volume * 2) }}
                  />
                ))}
              </div>
              <span className="text-xs font-black text-blue-400 uppercase tracking-[0.4em] animate-pulse">Capturing Live</span>
            </div>
            <p className="text-white text-3xl font-bold leading-tight min-h-[4rem]">
              {state.currentText || <span className="text-white/10 italic">Speak clearly in English...</span>}
            </p>
          </div>
        )}
      </main>

      {/* Hero Control */}
      <footer className="p-12 shrink-0 flex justify-center bg-gradient-to-t from-black via-black to-transparent relative z-30">
        <div className="relative">
          {!state.isRecording ? (
            <button
              onClick={startSession}
              disabled={state.status === 'connecting'}
              className="w-28 h-28 rounded-full bg-white text-black flex items-center justify-center shadow-2xl active:scale-90 transition-all border-[10px] border-black disabled:opacity-50 group"
            >
              <svg className="w-12 h-12 transition-transform group-hover:scale-110" fill="currentColor" viewBox="0 0 24 24"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/><path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>
            </button>
          ) : (
            <button
              onClick={stopSession}
              className="w-28 h-28 rounded-full bg-red-600 text-white flex items-center justify-center shadow-2xl active:scale-90 transition-all border-[10px] border-black relative z-10"
            >
              <svg className="w-12 h-12" fill="currentColor" viewBox="0 0 24 24"><path d="M6 6h12v12H6z"/></svg>
            </button>
          )}
          
          {/* Reactive Visualization Ring */}
          {state.isRecording && (
            <div 
              className="absolute inset-0 rounded-full bg-blue-500/20 -z-10 transition-transform duration-75"
              style={{ transform: `scale(${1.2 + volume * 10})` }}
            />
          )}
        </div>
      </footer>

      {/* Toast */}
      {toast && (
        <div className="fixed top-10 left-1/2 -translate-x-1/2 bg-white text-black px-8 py-3 rounded-full text-xs font-black shadow-2xl z-[100] animate-in slide-in-from-top-4">
          {toast}
        </div>
      )}

      {/* Error State */}
      {state.status === 'error' && (
        <div className="fixed inset-0 bg-red-600/95 backdrop-blur-xl flex flex-col items-center justify-center p-12 text-center z-[200]">
          <div className="w-20 h-20 mb-6 flex items-center justify-center rounded-full bg-white/20">
            <svg className="w-10 h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" /></svg>
          </div>
          <h2 className="text-3xl font-black mb-2 uppercase tracking-tighter">System Error</h2>
          <p className="text-white/60 mb-10 text-sm font-medium">Please refresh and grant microphone access.</p>
          <button onClick={() => window.location.reload()} className="px-12 py-5 bg-white text-red-600 rounded-full font-black uppercase tracking-widest text-xs">Reload App</button>
        </div>
      )}

      <style>{`
        .scrollbar-hide::-webkit-scrollbar { display: none; }
        .scrollbar-hide { -ms-overflow-style: none; scrollbar-width: none; }
      `}</style>
    </div>
  );
}
