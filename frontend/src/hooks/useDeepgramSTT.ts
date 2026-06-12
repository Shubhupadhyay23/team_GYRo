"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const DEEPGRAM_API_KEY = process.env.NEXT_PUBLIC_DEEPGRAM_API_KEY || "";
const MAX_RECONNECTS = 3;

export interface DeepgramSTTConfig {
  utterance_end_ms: number;
  endpointing: number;
  confidence_threshold: number;
  model: string;
  smart_format: boolean;
}

const DEFAULT_CONFIG: DeepgramSTTConfig = {
  utterance_end_ms: 1500,
  endpointing: 10,
  confidence_threshold: 0.0,
  model: "nova-2",
  smart_format: true,
};

function buildDeepgramUrl(config: DeepgramSTTConfig): string {
  const params = new URLSearchParams({
    model: config.model,
    smart_format: String(config.smart_format),
    interim_results: "true",
    vad_events: "true",
    utterance_end_ms: String(config.utterance_end_ms),
    endpointing: String(config.endpointing),
    encoding: "linear16",
    sample_rate: "16000",
  });
  return `wss://api.deepgram.com/v1/listen?${params}`;
}

export interface UseDeepgramSTTReturn {
  isListening: boolean;
  transcript: string;
  interimTranscript: string;
  startListening: () => void;
  stopListening: () => void;
  resetTranscript: () => void;
}

export function useDeepgramSTT(config?: DeepgramSTTConfig): UseDeepgramSTTReturn {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [interimTranscript, setInterimTranscript] = useState("");
  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const resumeIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectCountRef = useRef(0);
  // Track whether a close was intentional (config change) vs unexpected
  const intentionalCloseRef = useRef(false);
  const recognitionRef = useRef<any>(null);

  const activeConfig = config ?? DEFAULT_CONFIG;
  // Store config in a ref so connectWebSocket always sees the latest values
  const configRef = useRef(activeConfig);
  configRef.current = activeConfig;

  const startFallbackSpeechRecognition = useCallback(() => {
    if (recognitionRef.current) return;

    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      console.error("[DeepgramSTT] Neither Deepgram nor browser SpeechRecognition is available.");
      return;
    }

    console.log("[DeepgramSTT] Initializing browser-native SpeechRecognition fallback...");
    const recognition = new SpeechRecognition();
    recognitionRef.current = recognition;

    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onstart = () => {
      console.log("[DeepgramSTT] Native SpeechRecognition started");
      setIsListening(true);
    };

    recognition.onresult = (event: any) => {
      let finalTranscript = "";
      let interimTranscript = "";

      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          finalTranscript += event.results[i][0].transcript;
        } else {
          interimTranscript += event.results[i][0].transcript;
        }
      }

      if (finalTranscript) {
        console.log("[DeepgramSTT] Native Final transcript:", finalTranscript);
        setTranscript(finalTranscript);
      }
      setInterimTranscript(interimTranscript);
    };

    recognition.onerror = (event: any) => {
      console.error("[DeepgramSTT] Native SpeechRecognition error:", event.error);
      if (event.error === "not-allowed") {
        setIsListening(false);
      }
    };

    recognition.onend = () => {
      console.log("[DeepgramSTT] Native SpeechRecognition ended");
      if (recognitionRef.current === recognition) {
        try {
          recognition.start();
        } catch {
          setIsListening(false);
        }
      } else {
        setIsListening(false);
      }
    };

    try {
      recognition.start();
    } catch (err) {
      console.error("[DeepgramSTT] Failed to start Native SpeechRecognition:", err);
      setIsListening(false);
    }
  }, []);

  const cleanup = useCallback(() => {
    if (resumeIntervalRef.current) {
      clearInterval(resumeIntervalRef.current);
      resumeIntervalRef.current = null;
    }
    processorRef.current?.disconnect();
    processorRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (wsRef.current && wsRef.current.readyState <= WebSocket.OPEN) {
      wsRef.current.close();
    }
    wsRef.current = null;
    if (recognitionRef.current) {
      const rec = recognitionRef.current;
      recognitionRef.current = null;
      try {
        rec.stop();
      } catch {}
    }
    reconnectCountRef.current = 0;
    setIsListening(false);
    setInterimTranscript("");
  }, []);

  const connectWebSocket = useCallback(
    (stream: MediaStream) => {
      if (!DEEPGRAM_API_KEY) {
        console.warn("[DeepgramSTT] No API key configured, falling back to browser-native STT");
        if (stream) {
          stream.getTracks().forEach((t) => t.stop());
        }
        startFallbackSpeechRecognition();
        return;
      }

      const url = buildDeepgramUrl(configRef.current);
      console.log("[DeepgramSTT] Connecting with URL:", url);
      const ws = new WebSocket(url, ["token", DEEPGRAM_API_KEY]);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log("[MirrorV2:STT] Connected to Deepgram");
        setIsListening(true);
        reconnectCountRef.current = 0;

        // Clean up old audio pipeline if reconnecting
        if (resumeIntervalRef.current) {
          clearInterval(resumeIntervalRef.current);
          resumeIntervalRef.current = null;
        }
        processorRef.current?.disconnect();
        audioCtxRef.current?.close().catch(() => {});

        // Create fresh audio pipeline: mic → AudioContext → ScriptProcessor → WebSocket
        const audioCtx = new AudioContext({ sampleRate: 16000 });
        audioCtxRef.current = audioCtx;
        const source = audioCtx.createMediaStreamSource(stream);
        const processor = audioCtx.createScriptProcessor(4096, 1, 1);
        processorRef.current = processor;

        processor.onaudioprocess = (e) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          const float32 = e.inputBuffer.getChannelData(0);
          // Convert Float32 PCM to Int16 PCM
          const int16 = new Int16Array(float32.length);
          for (let i = 0; i < float32.length; i++) {
            const s = Math.max(-1, Math.min(1, float32[i]));
            int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
          }
          ws.send(int16.buffer);
        };

        source.connect(processor);
        processor.connect(audioCtx.destination);

        // Periodically resume AudioContext if browser suspends it (tab switch / idle)
        resumeIntervalRef.current = setInterval(() => {
          if (audioCtx.state === "suspended") {
            audioCtx.resume().catch(() => {});
          }
        }, 3000);
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          // Handle utterance end — clear interim
          if (data.type === "UtteranceEnd") {
            setInterimTranscript("");
            return;
          }

          const alt = data.channel?.alternatives?.[0];
          if (!alt) return;

          const text = alt.transcript;
          if (!text) return;

          // Apply confidence threshold filter
          const confidence = alt.confidence ?? 1.0;
          if (confidence < configRef.current.confidence_threshold) {
            console.log(`[STT] Rejected low-confidence transcript: ${confidence.toFixed(2)} < ${configRef.current.confidence_threshold}`);
            return;
          }

          if (data.is_final) {
            console.log("[STT] Final transcript:", text, `(confidence: ${confidence.toFixed(2)})`);
            setTranscript(text);
            setInterimTranscript("");
          } else {
            setInterimTranscript(text);
          }
        } catch {
          console.warn("[MirrorV2:STT] Non-JSON message received");
        }
      };

      ws.onclose = (event) => {
        console.warn("[MirrorV2:STT] Disconnected:", event.reason || `code=${event.code}`);

        // If this was an intentional close (config change), don't auto-reconnect
        if (intentionalCloseRef.current) {
          intentionalCloseRef.current = false;
          return;
        }

        // Exponential backoff reconnect (max 3 attempts)
        if (reconnectCountRef.current < MAX_RECONNECTS && streamRef.current) {
          reconnectCountRef.current += 1;
          const delay = Math.min(1000 * Math.pow(2, reconnectCountRef.current - 1), 5000);
          console.warn(`[MirrorV2:STT] Reconnecting, attempt: ${reconnectCountRef.current}/${MAX_RECONNECTS} in ${delay}ms`);
          setTimeout(() => {
            if (streamRef.current) {
              connectWebSocket(streamRef.current);
            }
          }, delay);
        } else if (reconnectCountRef.current >= MAX_RECONNECTS) {
          console.error("[MirrorV2:STT] Max reconnects reached, falling back to browser-native STT");
          if (streamRef.current) {
            streamRef.current.getTracks().forEach((t) => t.stop());
            streamRef.current = null;
          }
          startFallbackSpeechRecognition();
        } else {
          setIsListening(false);
        }
      };

      ws.onerror = () => {
        ws.close();
      };
    },
    [cleanup],
  );

  // Reconnect WebSocket when config changes (while already listening)
  useEffect(() => {
    if (!wsRef.current || !streamRef.current) return;

    console.log("[DeepgramSTT] Config changed, reconnecting...");
    intentionalCloseRef.current = true;
    reconnectCountRef.current = 0;

    // Close existing WebSocket — intentionalCloseRef prevents auto-reconnect in onclose
    if (wsRef.current.readyState <= WebSocket.OPEN) {
      wsRef.current.close();
    }
    wsRef.current = null;

    // Reconnect with existing mic stream (no re-prompt)
    connectWebSocket(streamRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConfig.utterance_end_ms, activeConfig.endpointing, activeConfig.confidence_threshold, activeConfig.model, activeConfig.smart_format]);

  const startListening = useCallback(async () => {
    if (wsRef.current) return;
    reconnectCountRef.current = 0;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      connectWebSocket(stream);
    } catch (err) {
      console.error("[MirrorV2:STT] Microphone access failed:", err instanceof Error ? err.message : err);
    }
  }, [connectWebSocket]);

  const stopListening = useCallback(() => {
    cleanup();
  }, [cleanup]);

  const resetTranscript = useCallback(() => {
    setTranscript("");
  }, []);

  return { isListening, transcript, interimTranscript, startListening, stopListening, resetTranscript };
}
