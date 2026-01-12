
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, Modality } from '@google/genai';
import { IdeaSnippet, TranscriptionState } from './types';
import { encodePCM } from './utils/audioUtils';

const SAMPLE_RATE = 16000;
const BUFFER_SIZE = 4096;

/**
 * Advanced Stenography Logic:
 * This function takes the current master transcript and a new chunk from the AI.
 * It finds the overlap to ensure words are never duplicated or deleted.
 */
function appendVerbatim(master: string, incoming: string): string {
  if (!incoming) return master;
  
  // Clean incoming text: Force Romanized characters only (remove Devanagari/Hindi)
  // This is a safety filter in case the model ignores system instructions.
  const cleanedIncoming = incoming.replace(/[^\x00-\x7F]/g, "").trim();
  if (!cleanedIncoming) return master;

  const masterWords = master.trim().split(/\s+/).filter(w => w.length > 0);
  const incomingWords = cleanedIncoming.split(/\s+/).filter(w => w.length > 0);

  // If master is empty, just take the incoming
  if (masterWords.length === 0) return cleanedIncoming;

  // Sliding window to find where incoming overlaps with the end of master.
  // We check the last 8 words for a match.
  let overlapIndex = -1;
  const maxOverlap = Math.min(masterWords.length, incomingWords.length, 8);

  for (let i = maxOverlap; i > 0; i--) {
    const masterTail = masterWords.slice(-i).join(" ").toLowerCase();
    const incomingHead = incomingWords.slice(0, i).join(" ").toLowerCase();
    if (masterTail === incomingHead) {
      overlapIndex = i;
      break;
    }
  }

  if (overlapIndex !== -1) {
    // Found overlap, append only the NEW words
    const uniqueIncoming = incomingWords.slice(overlapIndex).join(" ");
    return uniqueIncoming ? (master + " " + uniqueIncoming).trim() : master;
  } else {
    // No overlap found - this might be a new burst or a pause.
    // We APPEND it to avoid losing any data.
    return (master + " " + cleanedIncoming).trim();
  }
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
  
  // THE MASTER LOG - This is the only source of truth for the session
  const masterTranscriptRef = useRef<string>('');
  
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
    const finalTranscript = masterTranscriptRef.current.trim();
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
    masterTranscriptRef.current = '';
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
      masterTranscriptRef.current = '';

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
      
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(BUFFER_SIZE, 1, 1);

      const sessionPromise = aiRef.current.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          systemInstruction: `
            YOU ARE A MECHANICAL ROMAN-SCRIPT STENOGRAPHER.
            YOUR ONLY OUTPUT IS RAW ENGLISH TEXT.
            
            STRICT RULES:
            1. NO HINDI SCRIPT: Never use Devanagari or Hindi characters. Use English letters only.
            2. ROMANIZE EVERYTHING: If the user speaks Hindi, transcribe it phonetically in English (e.g., "Namaste").
            3. NO SUMMARIZATION: Capture every word. If a turn passes by, append it to the stream.
            4. ZERO DELETION: Never remove text that has been already transcribed.
            5. DUMB MODE: Do not correct grammar or add punctuation. Just words.
            6. LATIN CHARACTERS ONLY: Your output buffer must only contain ASCII characters.
          `,
        },
        callbacks: {
          onopen: () => {
            setState(prev => ({ ...prev, status: 'listening' }));
          },
          onmessage: (msg: any) => {
            const incoming = msg.serverContent?.inputTranscription?.text;
            if (incoming) {
              // Update master transcript with a robust additive logic
              const updated = appendVerbatim(masterTranscriptRef.current, incoming);
              if (updated !== masterTranscriptRef.current) {
                masterTranscriptRef.current = updated;
                setState(prev => ({ ...prev, currentText: masterTranscriptRef.current }));
              }
            }
          },
          onerror: (err) => {
            console.error('Session Link Lost:', err);
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
        let sum = 0;
        for (let i = 0; i < inputData.length; i++) sum += inputData[i] * inputData[i];
        setVolume(Math.sqrt(sum / inputData.length));

        const pcmBase64 = encodePCM(inputData);
        const media = { data: pcmBase64, mimeType: 'audio/pcm;rate=16000' };

        if (activeSessionRef.current) {
          activeSessionRef.current.sendRealtimeInput({ media });
        } else {
          sessionPromise.then(session => {
            session.sendRealtimeInput({ media });
          });
        }
      };
      
      source.connect(processor);
      processor.connect(audioContext.destination);
      if (audioContext.state === 'suspended') audioContext.resume();

    } catch (err) {
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
    <div className="flex flex-col h-screen max-w-2xl mx-auto bg-black text-white font-sans overflow-hidden">
      {/* Precision Header */}
      <header className="px-8 py-10 shrink-0 flex justify-between items-center border-b border-white/5 bg-black/60 backdrop-blur-3xl z-50">
        <div className="flex items-center gap-6">
          <div className="w-16 h-16 rounded-[1.5rem] bg-white text-black flex items-center justify-center shadow-[0_0_50px_rgba(255,255,255,0.1)]">
            <svg className="w-9 h-9" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>
          </div>
          <div>
            <h1 className="text-3xl font-black tracking-tighter leading-none uppercase italic">Verbatim<span className="text-blue-500">PRO</span></h1>
            <div className="flex items-center gap-2 mt-2">
              <span className={`w-2 h-2 rounded-full ${state.isRecording ? 'bg-red-500 animate-pulse' : 'bg-white/10'}`} />
              <span className="text-[10px] font-black text-white/30 uppercase tracking-[0.4em]">Permanent Log Link</span>
            </div>
          </div>
        </div>
        
        {state.history.length > 0 && (
          <button 
            onClick={() => confirm('Purge history?') && setState(prev => ({ ...prev, history: [] }))}
            className="w-12 h-12 flex items-center justify-center bg-white/5 rounded-2xl text-white/10 hover:text-red-500 transition-all active:scale-90"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
          </button>
        )}
      </header>

      {/* Main Stream Content */}
      <main className="flex-1 overflow-hidden flex flex-col">
        <div ref={liveOutputRef} className="flex-1 overflow-y-auto px-8 py-10 space-y-12 custom-scrollbar scroll-smooth">
          
          {/* Empty Prompt */}
          {state.history.length === 0 && !state.isRecording && (
            <div className="h-full flex flex-col items-center justify-center text-center opacity-10">
              <div className="w-48 h-48 mb-10 rounded-full border-2 border-white/20 border-dashed flex items-center justify-center">
                <svg className="w-16 h-16" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
              </div>
              <p className="text-xs font-black uppercase tracking-[1em]">Engine Idle</p>
            </div>
          )}

          {/* Historical Logs */}
          {state.history.map((snippet) => (
            <div key={snippet.id} className="animate-in fade-in slide-in-from-bottom-10 duration-500">
              <div className="bg-[#080808] border border-white/5 rounded-[3rem] p-12 relative group shadow-2xl overflow-hidden">
                <div className="absolute top-0 right-0 p-8 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button onClick={() => copyText(snippet.text)} className="p-4 bg-white/5 rounded-2xl text-blue-500 hover:bg-blue-500 hover:text-white transition-all">
                    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" /></svg>
                  </button>
                </div>
                <div className="flex items-center gap-4 mb-10 text-[10px] font-black tracking-widest uppercase">
                   <span className="text-white/40">Session Log</span>
                   <span className="w-1 h-1 rounded-full bg-white/10" />
                   <span className="text-blue-500/60">{snippet.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                </div>
                <p className="text-white/90 text-4xl font-light leading-snug tracking-tighter selection:bg-blue-600/30">
                  {snippet.text}
                </p>
              </div>
            </div>
          ))}

          {/* THE LIVE RUNNING BUFFER */}
          {state.isRecording && (
            <div className="animate-in slide-in-from-bottom-16 duration-700">
              <div className="bg-[#030303] border-4 border-white/5 rounded-[4rem] p-14 shadow-[0_0_150px_rgba(59,130,246,0.15)] relative overflow-hidden">
                <div className="flex items-center justify-between mb-12 border-b border-white/5 pb-12">
                  <div className="flex items-center gap-6">
                    <div className="flex items-end gap-2 h-12">
                      {[...Array(14)].map((_, i) => (
                        <div 
                          key={i} 
                          className="w-2 bg-blue-600 rounded-full transition-all duration-75"
                          style={{ height: `${20 + (volume * (2500 + i * 400))}%`, opacity: 0.2 + (volume * 10) }}
                        />
                      ))}
                    </div>
                    <div>
                      <span className="text-xs font-black text-blue-500 uppercase tracking-[0.6em] animate-pulse">Capturing Live Stream</span>
                      <p className="text-[10px] font-bold text-white/20 uppercase tracking-[0.3em] mt-2">{wordCount} words recorded in Roman script</p>
                    </div>
                  </div>
                  <div className="w-6 h-6 rounded-full bg-red-600 animate-ping shadow-[0_0_30px_rgba(220,38,38,0.4)]" />
                </div>
                
                <div className="text-white text-6xl font-black leading-[1.2] whitespace-pre-wrap tracking-tighter transition-all duration-300">
                  {state.currentText || <span className="text-white/5 font-normal italic">Speak Romanized...</span>}
                  <span className="inline-block w-3 h-16 bg-blue-600 ml-4 animate-pulse align-middle rounded-full shadow-[0_0_20px_rgba(37,99,235,1)]" />
                </div>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* Control Station */}
      <footer className="p-16 shrink-0 flex flex-col items-center bg-gradient-to-t from-black via-black to-transparent relative z-50">
        <div className="relative group">
          {!state.isRecording ? (
            <button
              onClick={startSession}
              disabled={state.status === 'connecting'}
              className="w-40 h-40 rounded-full bg-white text-black flex items-center justify-center shadow-[0_0_150px_rgba(255,255,255,0.1)] active:scale-90 transition-all border-[20px] border-black hover:scale-105 disabled:opacity-50"
            >
              <svg className="w-16 h-16" fill="currentColor" viewBox="0 0 24 24"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/><path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>
            </button>
          ) : (
            <button
              onClick={stopSession}
              className="w-40 h-40 rounded-full bg-red-600 text-white flex items-center justify-center shadow-[0_0_150px_rgba(220,38,38,0.4)] active:scale-90 transition-all border-[20px] border-black relative z-10"
            >
              <svg className="w-20 h-20" fill="currentColor" viewBox="0 0 24 24"><path d="M6 6h12v12H6z"/></svg>
            </button>
          )}
          
          {/* REACTIVE ENERGY CORE */}
          {state.isRecording && (
            <div 
              className="absolute inset-0 rounded-full bg-blue-600/20 -z-10 transition-transform duration-75 blur-[150px]"
              style={{ transform: `scale(${1.8 + volume * 40})` }}
            />
          )}
        </div>
        
        <p className="mt-12 text-[11px] font-black text-white/10 uppercase tracking-[0.7em]">
          {state.isRecording ? 'Capturing Verbatim' : 'Initialize Monologue Link'}
        </p>
      </footer>

      {/* Copy Alerts */}
      {toast && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 bg-blue-600 text-white px-16 py-7 rounded-full text-[10px] font-black shadow-[0_50px_100px_rgba(0,0,0,0.8)] z-[100] animate-in slide-in-from-top-20 border border-blue-400/30 tracking-[0.4em] uppercase">
          {toast}
        </div>
      )}

      {/* Error Logic */}
      {state.status === 'error' && (
        <div className="fixed inset-0 bg-black flex flex-col items-center justify-center p-20 text-center z-[200] animate-in fade-in duration-1000">
          <div className="w-32 h-32 bg-red-600/10 text-red-600 rounded-[3.5rem] flex items-center justify-center mb-14 border border-red-600/20">
             <svg className="w-16 h-16" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
          </div>
          <h2 className="text-5xl font-black mb-8 tracking-tighter uppercase italic">Link Broken</h2>
          <p className="text-white/40 mb-20 text-xl font-medium max-w-[400px] mx-auto leading-relaxed italic opacity-60">The Roman-script buffer was disconnected. Check signal strength and reconnect.</p>
          <button onClick={() => window.location.reload()} className="px-24 py-8 bg-white text-black rounded-full font-black uppercase text-xs tracking-[0.6em] active:scale-95 transition-all shadow-2xl">Establish Re-Sync</button>
        </div>
      )}

      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 4px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: rgba(59, 130, 246, 0.2); border-radius: 10px; }
        .custom-scrollbar { scrollbar-width: thin; scrollbar-color: rgba(59, 130, 246, 0.1) transparent; }
      `}</style>
    </div>
  );
}
