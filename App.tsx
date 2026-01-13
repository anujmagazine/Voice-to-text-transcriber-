
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, Modality } from '@google/genai';
import { IdeaSnippet, TranscriptionState } from './types';
import { encodePCM } from './utils/audioUtils';

const SAMPLE_RATE = 16000;
const BUFFER_SIZE = 4096;

/**
 * Filter to strip non-ASCII characters (e.g., Hindi Devanagari) 
 * to ensure verbatim Romanized logging.
 */
function stripNonRoman(text: string): string {
  return text.replace(/[^\x00-\x7F]/g, "");
}

export default function App() {
  const [state, setState] = useState<TranscriptionState>({
    currentText: '',
    history: [],
    isRecording: false,
    status: 'idle',
  });
  
  const [toast, setToast] = useState<string | null>(null);
  const [volume, setVolume] = useState(0);
  const [wordCount, setWordCount] = useState(0);

  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const activeSessionRef = useRef<any>(null);
  const liveOutputRef = useRef<HTMLDivElement>(null);
  
  // Confirmed text from previous turns
  const permanentTranscriptRef = useRef<string>('');
  // Delta accumulator for the current live turn
  const turnDeltaRef = useRef<string>('');
  
  const aiRef = useRef(new GoogleGenAI({ apiKey: process.env.API_KEY || '' }));

  useEffect(() => {
    if (liveOutputRef.current) {
      liveOutputRef.current.scrollTop = liveOutputRef.current.scrollHeight;
    }
    const words = state.currentText.trim().split(/\s+/).filter(w => w.length > 0);
    setWordCount(words.length);
  }, [state.currentText]);

  const cleanup = useCallback(async () => {
    activeSessionRef.current = null;
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

  const saveToHistory = useCallback(() => {
    // Combine everything into a final block
    const finalTranscript = (permanentTranscriptRef.current + " " + turnDeltaRef.current).trim();
    if (finalTranscript.length > 0) {
      const snippet: IdeaSnippet = {
        id: crypto.randomUUID(),
        text: finalTranscript,
        timestamp: new Date(),
      };
      setState(prev => ({
        ...prev,
        history: [...prev.history, snippet],
        currentText: ''
      }));
    }
    permanentTranscriptRef.current = '';
    turnDeltaRef.current = '';
    setState(prev => ({ ...prev, currentText: '' }));
  }, []);

  const stopSession = useCallback(async () => {
    saveToHistory();
    setState(prev => ({ ...prev, isRecording: false, status: 'idle' }));
    await cleanup();
  }, [cleanup, saveToHistory]);

  const startSession = async () => {
    try {
      setState(prev => ({ ...prev, status: 'connecting', isRecording: true, currentText: '' }));
      permanentTranscriptRef.current = '';
      turnDeltaRef.current = '';

      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: { 
          echoCancellation: true, 
          noiseSuppression: true, 
          autoGainControl: true 
        } 
      });
      streamRef.current = stream;

      // Ensure 16kHz resampling for the AI model
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: SAMPLE_RATE });
      audioContextRef.current = audioContext;
      
      const source = audioContext.createMediaStreamSource(stream);
      // Processor to handle raw audio samples
      const processor = audioContext.createScriptProcessor(BUFFER_SIZE, 1, 1);

      const sessionPromise = aiRef.current.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {}, // Request real-time transcription of user audio
          systemInstruction: `
            IDENTITY: MECHANICAL DIGITAL STENOGRAPHER.
            MISSION: VERBATIM VOICE-LOGGING.
            RULES:
            1. ROMAN SCRIPT ONLY: Use Latin characters (A-Z) for all output. 
            2. NO HINDI SCRIPT: Never use Devanagari characters. If Hindi is spoken, write it phonetically in English.
            3. ADDITIVE DELTAS: Output transcription as soon as words are identified.
            4. ZERO EDITING: Do not summarize or correct. Capture exactly what is heard.
          `,
        },
        callbacks: {
          onopen: () => {
            setState(prev => ({ ...prev, status: 'listening' }));
          },
          onmessage: (msg: any) => {
            // Correct Delta Event Parsing
            if (msg.serverContent?.inputTranscription) {
              const delta = msg.serverContent.inputTranscription.text;
              turnDeltaRef.current += delta;
              
              const fullText = (permanentTranscriptRef.current + " " + turnDeltaRef.current).trim();
              // Apply Roman-only filter to display
              setState(prev => ({ ...prev, currentText: stripNonRoman(fullText) }));
            }

            // Lock current turn into permanent memory when turn finishes
            if (msg.serverContent?.turnComplete) {
              permanentTranscriptRef.current = (permanentTranscriptRef.current + " " + turnDeltaRef.current).trim();
              turnDeltaRef.current = '';
            }
          },
          onerror: (err) => {
            console.error('Session Lost:', err);
            setState(prev => ({ ...prev, status: 'error' }));
            stopSession();
          },
          onclose: () => {
            setState(prev => ({ ...prev, isRecording: false, status: 'idle' }));
          }
        }
      });

      sessionPromise.then(session => {
        activeSessionRef.current = session;
      });

      processor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        // Compute volume for the visualization ring
        let sum = 0;
        for (let i = 0; i < inputData.length; i++) sum += inputData[i] * inputData[i];
        setVolume(Math.sqrt(sum / inputData.length));

        // Binary PCM -> Base64 pipeline
        const pcmBase64 = encodePCM(inputData);
        const media = { data: pcmBase64, mimeType: 'audio/pcm;rate=16000' };

        // Send to Live API via WebSocket session
        sessionPromise.then(session => {
          session.sendRealtimeInput({ media });
        });
      };
      
      source.connect(processor);
      processor.connect(audioContext.destination);
      if (audioContext.state === 'suspended') audioContext.resume();

    } catch (err) {
      console.error('Microphone access failed:', err);
      setState(prev => ({ ...prev, status: 'error', isRecording: false }));
      cleanup();
    }
  };

  const copyText = (text: string) => {
    navigator.clipboard.writeText(text);
    setToast('COPIED VERBATIM');
    setTimeout(() => setToast(null), 2000);
  };

  return (
    <div className="flex flex-col h-screen max-w-2xl mx-auto bg-black text-white font-sans overflow-hidden">
      {/* Precision Header */}
      <header className="px-8 py-10 shrink-0 flex justify-between items-center border-b border-white/5 bg-black/80 backdrop-blur-2xl z-50">
        <div className="flex items-center gap-5">
          <div className="w-14 h-14 rounded-2xl bg-blue-600 text-white flex items-center justify-center shadow-lg shadow-blue-500/20">
            <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight leading-none uppercase italic">Digital<span className="text-blue-500">Stenographer</span></h1>
            <div className="flex items-center gap-2 mt-2">
              <span className={`w-2 h-2 rounded-full ${state.isRecording ? 'bg-red-500 animate-pulse' : 'bg-white/10'}`} />
              <span className="text-[10px] font-black text-white/30 uppercase tracking-[0.3em]">Hands-free idea capture</span>
            </div>
          </div>
        </div>
        
        {state.history.length > 0 && (
          <button 
            onClick={() => confirm('Purge current history?') && setState(prev => ({ ...prev, history: [] }))}
            className="w-10 h-10 flex items-center justify-center bg-white/5 rounded-xl text-white/10 hover:text-red-500 transition-all active:scale-90"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
          </button>
        )}
      </header>

      {/* Main Stream Content */}
      <main className="flex-1 overflow-hidden flex flex-col">
        <div ref={liveOutputRef} className="flex-1 overflow-y-auto px-8 py-8 space-y-8 custom-scrollbar scroll-smooth">
          
          {/* Empty Prompt */}
          {state.history.length === 0 && !state.isRecording && (
            <div className="h-full flex flex-col items-center justify-center text-center opacity-10">
              <div className="w-36 h-36 mb-8 rounded-full border-2 border-white/10 border-dashed flex items-center justify-center">
                <svg className="w-12 h-12" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
              </div>
              <p className="text-[9px] font-black uppercase tracking-[0.8em]">Awaiting Voice Link</p>
            </div>
          )}

          {/* Historical Logs */}
          {state.history.map((snippet) => (
            <div key={snippet.id} className="animate-in fade-in slide-in-from-bottom-4 duration-500">
              <div className="bg-[#0a0a0a] border border-white/5 rounded-[2rem] p-8 relative group shadow-sm">
                <div className="absolute top-6 right-6 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button onClick={() => copyText(snippet.text)} className="p-2.5 bg-white/5 rounded-xl text-blue-500 hover:bg-blue-600 hover:text-white transition-all">
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" /></svg>
                  </button>
                </div>
                <div className="flex items-center gap-3 mb-5 text-[9px] font-black tracking-widest uppercase">
                   <span className="text-white/20">Archived Session</span>
                   <span className="text-blue-500/40">{snippet.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                </div>
                {/* Reduced font size for history as requested */}
                <p className="text-white/60 text-lg font-normal leading-relaxed tracking-tight">
                  {snippet.text}
                </p>
              </div>
            </div>
          ))}

          {/* THE LIVE RUNNING BUFFER */}
          {state.isRecording && (
            <div className="animate-in slide-in-from-bottom-6 duration-500">
              <div className="bg-[#030303] border-2 border-white/5 rounded-[2.5rem] p-8 shadow-2xl relative overflow-hidden">
                <div className="flex items-center justify-between mb-8 border-b border-white/5 pb-8">
                  <div className="flex items-center gap-4">
                    <div className="flex items-end gap-1.5 h-5">
                      {[...Array(8)].map((_, i) => (
                        <div 
                          key={i} 
                          className="w-1 bg-blue-600 rounded-full transition-all duration-75"
                          style={{ height: `${20 + (volume * (1500 + i * 200))}%`, opacity: 0.3 + (volume * 8) }}
                        />
                      ))}
                    </div>
                    <div>
                      <span className="text-[9px] font-black text-blue-500 uppercase tracking-[0.3em] animate-pulse">Engaged</span>
                      <p className="text-[8px] font-bold text-white/20 uppercase tracking-[0.2em] mt-1">{wordCount} words logged</p>
                    </div>
                  </div>
                  <div className="w-2.5 h-2.5 rounded-full bg-red-600 animate-ping shadow-sm" />
                </div>
                
                {/* Reduced font size for live text as requested */}
                <div className="text-white text-xl font-bold leading-relaxed tracking-tight transition-all duration-300">
                  {state.currentText || <span className="text-white/5 font-normal italic">Initialize voice input...</span>}
                  <span className="inline-block w-1.5 h-6 bg-blue-600 ml-2 animate-pulse align-middle rounded-full" />
                </div>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* Footer Interface */}
      <footer className="p-10 shrink-0 flex flex-col items-center bg-gradient-to-t from-black via-black to-transparent relative z-50">
        <div className="relative group">
          {!state.isRecording ? (
            <button
              onClick={startSession}
              disabled={state.status === 'connecting'}
              className="w-28 h-28 rounded-full bg-white text-black flex items-center justify-center shadow-xl active:scale-95 transition-all border-[10px] border-black hover:scale-105 disabled:opacity-50"
            >
              <svg className="w-10 h-10" fill="currentColor" viewBox="0 0 24 24"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/><path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>
            </button>
          ) : (
            <button
              onClick={stopSession}
              className="w-28 h-28 rounded-full bg-red-600 text-white flex items-center justify-center shadow-xl active:scale-95 transition-all border-[10px] border-black relative z-10"
            >
              <svg className="w-12 h-12" fill="currentColor" viewBox="0 0 24 24"><path d="M6 6h12v12H6z"/></svg>
            </button>
          )}
          
          {/* Sonic Field Effect */}
          {state.isRecording && (
            <div 
              className="absolute inset-0 rounded-full bg-blue-600/10 -z-10 transition-transform duration-75 blur-[70px]"
              style={{ transform: `scale(${1.3 + volume * 35})` }}
            />
          )}
        </div>
        
        <p className="mt-8 text-[8px] font-black text-white/10 uppercase tracking-[0.5em]">
          {state.isRecording ? 'Capturing monologue' : 'Engage Voice Station'}
        </p>
      </footer>

      {/* Copy Notification */}
      {toast && (
        <div className="fixed top-12 left-1/2 -translate-x-1/2 bg-blue-600 text-white px-8 py-3 rounded-full text-[8px] font-black shadow-2xl z-[100] animate-in slide-in-from-top-12 border border-blue-400/10 tracking-[0.2em] uppercase">
          {toast}
        </div>
      )}

      {/* Recovery Overlay */}
      {state.status === 'error' && (
        <div className="fixed inset-0 bg-black/95 flex flex-col items-center justify-center p-16 text-center z-[200] animate-in fade-in duration-500 backdrop-blur-xl">
          <div className="w-16 h-16 bg-red-600/10 text-red-600 rounded-2xl flex items-center justify-center mb-10 border border-red-600/10 shadow-sm">
             <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
          </div>
          <h2 className="text-2xl font-black mb-4 tracking-tighter uppercase italic">Signal Broken</h2>
          <p className="text-white/20 mb-10 text-sm font-medium max-w-[240px] mx-auto leading-relaxed">Mechanical verbatim link terminated unexpectedly.</p>
          <button onClick={() => window.location.reload()} className="px-12 py-5 bg-white text-black rounded-full font-black uppercase text-[9px] tracking-[0.4em] active:scale-95 transition-all shadow-md">Re-Engage Sync</button>
        </div>
      )}

      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 2px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: rgba(59, 130, 246, 0.1); border-radius: 10px; }
        .custom-scrollbar { scrollbar-width: thin; scrollbar-color: rgba(59, 130, 246, 0.05) transparent; }
      `}</style>
    </div>
  );
}
