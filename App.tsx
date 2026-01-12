
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, Modality } from '@google/genai';
import { IdeaSnippet, TranscriptionState } from './types';
import { encodePCM } from './utils/audioUtils';

const SAMPLE_RATE = 16000;
const BUFFER_SIZE = 4096;
const SILENCE_THRESHOLD = 0.008; // Filters out car/wind noise to prevent AI hallucinations

export default function App() {
  const [state, setState] = useState<TranscriptionState>({
    currentText: '',
    history: [],
    isRecording: false,
    status: 'idle',
  });
  
  const [toast, setToast] = useState<string | null>(null);
  const [visualizerLevel, setVisualizerLevel] = useState(0);

  // High-performance refs
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sessionRef = useRef<any>(null);
  const historyContainerRef = useRef<HTMLDivElement>(null);
  const activeTranscriptionRef = useRef<string>('');

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
    setVisualizerLevel(0);
  }, []);

  const saveSnippet = useCallback(() => {
    const text = activeTranscriptionRef.current.trim();
    if (text.length > 3) {
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
    activeTranscriptionRef.current = '';
    setState(prev => ({ ...prev, currentText: '' }));
  }, []);

  const stopSession = useCallback(async () => {
    saveSnippet();
    setState(prev => ({ ...prev, isRecording: false, status: 'idle' }));
    await cleanup();
  }, [cleanup, saveSnippet]);

  const startSession = async () => {
    try {
      setState(prev => ({ ...prev, status: 'connecting', isRecording: true, currentText: '' }));
      activeTranscriptionRef.current = '';

      // 1. Audio Setup
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

      // 2. Initialize Gemini Live
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
      
      const session = await ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          systemInstruction: `
            PRIMARY DIRECTIVE: High-speed English Speech-to-Text engine.
            LANGUAGE: Strictly English ONLY. 
            MANDATORY RULES:
            1. Transcribe audio input into English text immediately.
            2. NEVER use Hindi or any other script.
            3. If the user speaks Hindi, IGNORE IT COMPLETELY. Do not translate.
            4. If the audio is just background noise, output NOTHING.
            5. No summaries, no helpful tips, no conversation. Just verbatim English STT.
          `,
        },
        callbacks: {
          onopen: () => {
            setState(prev => ({ ...prev, status: 'listening' }));
            
            const source = audioContext.createMediaStreamSource(stream);
            const processor = audioContext.createScriptProcessor(BUFFER_SIZE, 1, 1);
            
            processor.onaudioprocess = (e) => {
              if (!sessionRef.current) return;
              
              const inputData = e.inputBuffer.getChannelData(0);
              
              // Local loudness check
              let sum = 0;
              for (let i = 0; i < inputData.length; i++) sum += inputData[i] * inputData[i];
              const rms = Math.sqrt(sum / inputData.length);
              setVisualizerLevel(rms);

              // Silence gating: prevents AI drift when you aren't talking
              if (rms > SILENCE_THRESHOLD) {
                const pcmBase64 = encodePCM(inputData);
                sessionRef.current.sendRealtimeInput({
                  media: { data: pcmBase64, mimeType: 'audio/pcm;rate=16000' }
                });
              }
            };
            
            source.connect(processor);
            processor.connect(audioContext.destination);
            if (audioContext.state === 'suspended') audioContext.resume();
          },
          onmessage: (msg: any) => {
            // Live transcription update
            const text = msg.serverContent?.inputTranscription?.text;
            if (text) {
              activeTranscriptionRef.current += text;
              setState(prev => ({ ...prev, currentText: activeTranscriptionRef.current }));
            }
            
            // Sentence completion logic
            if (msg.serverContent?.turnComplete) {
              saveSnippet();
            }
          },
          onerror: (err) => {
            console.error('Session error:', err);
            setState(prev => ({ ...prev, status: 'error' }));
            stopSession();
          },
          onclose: () => {
            setState(prev => ({ ...prev, isRecording: false, status: 'idle' }));
          }
        }
      });

      sessionRef.current = session;
    } catch (err) {
      console.error('Failed to start session:', err);
      setState(prev => ({ ...prev, status: 'error', isRecording: false }));
      cleanup();
    }
  };

  const copyText = (text: string) => {
    navigator.clipboard.writeText(text);
    setToast('COPIED TO CLIPBOARD');
    setTimeout(() => setToast(null), 2000);
  };

  return (
    <div className="flex flex-col h-screen max-w-lg mx-auto bg-[#050505] text-white font-sans overflow-hidden">
      {/* Sleek Header */}
      <header className="p-8 shrink-0 flex justify-between items-center bg-black/40 backdrop-blur-xl border-b border-white/5 z-30">
        <div>
          <h1 className="text-2xl font-black italic tracking-tight text-white/90">
            IDEA<span className="text-blue-600">FLOW</span>
          </h1>
          <div className="flex items-center gap-2 mt-0.5">
            <div className={`w-1.5 h-1.5 rounded-full ${state.isRecording ? 'bg-red-500 animate-pulse' : 'bg-white/20'}`} />
            <span className="text-[9px] font-bold text-white/40 uppercase tracking-widest">
              {state.status === 'listening' ? 'Native Transcription Active' : state.status === 'connecting' ? 'Linking Neural Engine' : 'Drive Safe • Capture Ideas'}
            </span>
          </div>
        </div>
        {state.history.length > 0 && (
          <button 
            onClick={() => confirm('Erase all session data?') && setState(prev => ({ ...prev, history: [] }))}
            className="w-10 h-10 flex items-center justify-center rounded-xl bg-white/5 hover:bg-red-500/20 text-white/30 hover:text-red-500 transition-all border border-white/5"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
          </button>
        )}
      </header>

      {/* Main Feed */}
      <main className="flex-1 overflow-y-auto px-6 py-8 space-y-6 scrollbar-hide" ref={historyContainerRef}>
        {state.history.length === 0 && !state.isRecording && (
          <div className="h-full flex flex-col items-center justify-center text-center opacity-20 py-20">
            <div className="w-20 h-20 mb-6 flex items-center justify-center rounded-3xl border border-white/10">
              <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>
            </div>
            <p className="text-sm font-medium tracking-tight">Tap the mic to start capturing thoughts.</p>
          </div>
        )}

        {/* History Items */}
        {state.history.map((snippet) => (
          <div key={snippet.id} className="group animate-in fade-in slide-in-from-bottom-2 duration-500">
            <div className="bg-[#111111] border border-white/[0.03] rounded-3xl p-6 transition-all hover:bg-[#161616] active:scale-[0.98]">
              <div className="flex justify-between items-start mb-4">
                <span className="text-[10px] font-bold text-blue-500/50 bg-blue-500/5 px-2.5 py-1 rounded-lg uppercase">
                  {snippet.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
                <button onClick={() => copyText(snippet.text)} className="p-2 text-white/20 hover:text-white transition-colors">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" /></svg>
                </button>
              </div>
              <p className="text-white/90 text-xl font-medium leading-relaxed tracking-tight">
                {snippet.text}
              </p>
            </div>
          </div>
        ))}

        {/* Active Session Box */}
        {state.isRecording && (
          <div className="bg-blue-600/10 border-2 border-blue-500/40 rounded-[2.5rem] p-8 shadow-[0_0_80px_rgba(37,99,235,0.1)] relative group">
            <div className="flex items-center gap-3 mb-6">
              <div className="flex items-end gap-1 h-5">
                {[...Array(6)].map((_, i) => (
                  <div 
                    key={i} 
                    className="w-1 bg-blue-500 rounded-full transition-all duration-75"
                    style={{ height: `${20 + (visualizerLevel * (500 + i * 200))}%` }}
                  />
                ))}
              </div>
              <span className="text-[10px] font-black text-blue-500 uppercase tracking-[0.3em] animate-pulse">Capturing Live</span>
            </div>
            <p className="text-white text-3xl font-bold leading-tight min-h-[5rem]">
              {state.currentText || <span className="text-white/20 italic">Listening for ideas...</span>}
            </p>
          </div>
        )}
      </main>

      {/* Control Hub */}
      <footer className="p-12 shrink-0 flex justify-center bg-gradient-to-t from-black via-black to-transparent z-40">
        <div className="relative">
          {!state.isRecording ? (
            <button
              onClick={startSession}
              disabled={state.status === 'connecting'}
              className="w-24 h-24 rounded-full bg-white text-black flex items-center justify-center shadow-[0_0_50px_rgba(255,255,255,0.1)] active:scale-90 transition-all border-[8px] border-black disabled:opacity-50 group"
            >
              <svg className="w-10 h-10 group-hover:scale-110 transition-transform" fill="currentColor" viewBox="0 0 24 24"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/><path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>
            </button>
          ) : (
            <button
              onClick={stopSession}
              className="w-24 h-24 rounded-full bg-red-600 text-white flex items-center justify-center shadow-[0_0_50px_rgba(220,38,38,0.2)] active:scale-90 transition-all border-[8px] border-black relative z-10"
            >
              <svg className="w-10 h-10" fill="currentColor" viewBox="0 0 24 24"><path d="M6 6h12v12H6z"/></svg>
            </button>
          )}
          
          {/* Reactive Background Ring */}
          {state.isRecording && (
            <div 
              className="absolute inset-0 rounded-full bg-blue-500/20 -z-10 transition-transform duration-75"
              style={{ transform: `scale(${1.2 + visualizerLevel * 12})` }}
            />
          )}
        </div>
      </footer>

      {/* Copy Toast */}
      {toast && (
        <div className="fixed top-10 left-1/2 -translate-x-1/2 bg-white text-black px-6 py-2.5 rounded-full text-[10px] font-black shadow-2xl z-[100] animate-in slide-in-from-top-4">
          {toast}
        </div>
      )}

      {/* Error State */}
      {state.status === 'error' && (
        <div className="fixed inset-0 bg-red-600/95 backdrop-blur-xl flex flex-col items-center justify-center p-12 text-center z-[200]">
          <h2 className="text-3xl font-black mb-4 uppercase tracking-tighter">System Malfunction</h2>
          <p className="text-white/70 mb-10 text-sm">Microphone or connection lost. Ensure permissions are granted.</p>
          <button onClick={() => window.location.reload()} className="px-10 py-4 bg-white text-red-600 rounded-full font-black uppercase text-xs tracking-widest">Restore Link</button>
        </div>
      )}

      <style>{`
        .scrollbar-hide::-webkit-scrollbar { display: none; }
        .scrollbar-hide { -ms-overflow-style: none; scrollbar-width: none; }
      `}</style>
    </div>
  );
}
