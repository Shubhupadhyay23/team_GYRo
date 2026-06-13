/**
 * Streaming TTS client using ElevenLabs REST streaming endpoint.
 *
 * Uses fetch + ReadableStream + MediaSource API for low-latency audio playback.
 * Extracts real-time volume via AudioContext + AnalyserNode for Orb visualization.
 *
 * Supports two modes:
 * - speak(): Cancels any current/queued audio and plays immediately (interruption)
 * - speakQueued(): Enqueues a sentence for sequential playback (sentence streaming)
 */

interface QueueEntry {
  text: string;
  onStart?: () => void;
  onEnd?: () => void;
}

export class StreamingTTS {
  private apiUrl: string;
  private generation = 0;
  private speaking = false;
  private isBrowserSpeaking = false;
  private audio: HTMLAudioElement | null = null;
  private mediaSource: MediaSource | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private sourceNode: MediaElementAudioSourceNode | null = null;
  private frequencyData: Uint8Array<ArrayBuffer> | null = null;
  private pendingResolve: (() => void) | null = null;

  // Sentence queue for sequential playback
  private queue: QueueEntry[] = [];
  private queueProcessing = false;
  private queueGeneration = 0;
  private onQueueDrain?: () => void;

  constructor(apiUrl: string) {
    this.apiUrl = apiUrl;
  }

  /**
   * Stream TTS audio for the given text.
   * CANCELS any current/queued audio and plays immediately.
   * Use this for interruptions or single-shot speech.
   */
  async speak(
    text: string,
    onStart?: () => void,
    onEnd?: () => void,
  ): Promise<void> {
    // Clear the queue — this is an interruption
    this.queue = [];
    this.queueGeneration++;
    this.onQueueDrain = undefined;

    const gen = ++this.generation;

    try {
      this.speaking = true;

      const resp = await fetch(`${this.apiUrl}/api/tts/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });

      if (this.generation !== gen) {
        this.speaking = false;
        return;
      }

      if (!resp.ok || !resp.body) {
        throw new Error(`TTS stream failed: ${resp.status}`);
      }

      await this.playStream(resp.body, gen, onStart, onEnd);
    } catch (err) {
      console.warn("[StreamingTTS] ElevenLabs stream failed, falling back to browser SpeechSynthesis:", err);
      this.playBrowserSpeech(text, gen, onStart, onEnd);
    }
  }

  /**
   * Enqueue a sentence for sequential playback.
   * Sentences play back-to-back without canceling each other.
   * Call onAllDone() to set a callback when the entire queue drains.
   */
  speakQueued(
    text: string,
    onStart?: () => void,
    onEnd?: () => void,
  ): void {
    if (!text.trim()) return;
    this.queue.push({ text, onStart, onEnd });
    this.speaking = true;
    this.processQueue();
  }

  /**
   * Set a callback that fires when the queue fully drains (all sentences done).
   */
  onAllDone(callback: () => void): void {
    this.onQueueDrain = callback;
  }

  private async processQueue(): Promise<void> {
    if (this.queueProcessing) return;
    this.queueProcessing = true;

    const qGen = this.queueGeneration;

    while (this.queue.length > 0) {
      if (this.queueGeneration !== qGen) break;

      const entry = this.queue.shift()!;
      const gen = ++this.generation;

      try {
        console.log(`[StreamingTTS] Queue: playing sentence (${entry.text.length} chars, ${this.queue.length} remaining)`);

        const resp = await fetch(`${this.apiUrl}/api/tts/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: entry.text }),
        });

        if (this.generation !== gen || this.queueGeneration !== qGen) {
          entry.onEnd?.();
          break;
        }

        if (!resp.ok || !resp.body) {
          throw new Error(`TTS stream failed: ${resp.status}`);
        }

        await this.playStream(resp.body, gen, entry.onStart, entry.onEnd);
      } catch (err) {
        console.warn("[StreamingTTS] ElevenLabs queue entry failed, falling back to browser SpeechSynthesis:", err);
        if (this.generation === gen && this.queueGeneration === qGen) {
          await new Promise<void>((resolve) => {
            this.playBrowserSpeech(
              entry.text,
              gen,
              entry.onStart,
              () => {
                entry.onEnd?.();
                resolve();
              }
            );
          });
        } else {
          entry.onEnd?.();
        }
      }
    }

    this.queueProcessing = false;

    // If queue is empty and we weren't interrupted, fire drain callback
    if (this.queue.length === 0 && this.queueGeneration === qGen) {
      this.speaking = false;
      const cb = this.onQueueDrain;
      this.onQueueDrain = undefined;
      cb?.();
    }
  }

  private async playStream(
    body: ReadableStream<Uint8Array>,
    gen: number,
    onStart?: () => void,
    onEnd?: () => void,
  ): Promise<void> {
    // Trigger onStart immediately so the text display is printed instantly
    onStart?.();

    return new Promise<void>((resolve) => {
      this.pendingResolve = resolve;

      const mediaSource = new MediaSource();
      this.mediaSource = mediaSource;

      const audio = new Audio();
      this.audio = audio;
      audio.src = URL.createObjectURL(mediaSource);

      // Connect to AudioContext for volume analysis
      this.connectAnalyser(audio);

      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        this.pendingResolve = null;
        // Don't set speaking=false here — the queue processor manages that
        if (audio.src) {
          URL.revokeObjectURL(audio.src);
        }
        onEnd?.();
        resolve();
      };

      audio.onerror = done;
      audio.onended = done;

      mediaSource.addEventListener("sourceopen", () => {
        if (this.generation !== gen) {
          done();
          return;
        }

        let sourceBuffer: SourceBuffer;
        try {
          sourceBuffer = mediaSource.addSourceBuffer("audio/mpeg");
        } catch {
          console.error("[StreamingTTS] Failed to add source buffer");
          done();
          return;
        }

        const reader = body.getReader();
        let started = false;

        const pump = async () => {
          try {
            const { done: readerDone, value } = await reader.read();

            if (this.generation !== gen) {
              reader.cancel();
              if (mediaSource.readyState === "open") {
                mediaSource.endOfStream();
              }
              done();
              return;
            }

            if (readerDone) {
              if (mediaSource.readyState === "open" && !sourceBuffer.updating) {
                mediaSource.endOfStream();
              } else if (mediaSource.readyState === "open") {
                sourceBuffer.addEventListener(
                  "updateend",
                  () => {
                    if (mediaSource.readyState === "open") {
                      mediaSource.endOfStream();
                    }
                  },
                  { once: true },
                );
              }
              console.log("[StreamingTTS] Stream complete");
              return;
            }

            if (sourceBuffer.updating) {
              // Wait for the current update to finish before appending
              await new Promise<void>((res) => {
                sourceBuffer.addEventListener("updateend", () => res(), {
                  once: true,
                });
              });
            }

            sourceBuffer.appendBuffer(value as unknown as BufferSource);

            if (!started) {
              started = true;
              console.log("[StreamingTTS] Playback starting");
              audio.play().catch(() => {
                console.warn("[StreamingTTS] Autoplay blocked");
              });
            }

            sourceBuffer.addEventListener("updateend", () => pump(), {
              once: true,
            });
          } catch (err) {
            console.error("[StreamingTTS] Pump error:", err);
            done();
          }
        };

        pump();
      });
    });
  }

  private connectAnalyser(audio: HTMLAudioElement): void {
    try {
      if (!this.audioContext) {
        this.audioContext = new AudioContext();
        this.analyser = this.audioContext.createAnalyser();
        this.analyser.fftSize = 256;
        this.analyser.smoothingTimeConstant = 0.7;
        this.analyser.connect(this.audioContext.destination);
        this.frequencyData = new Uint8Array(this.analyser.frequencyBinCount);
      }

      // Resume context if suspended (browser autoplay policy)
      if (this.audioContext.state === "suspended") {
        this.audioContext.resume();
      }

      // createMediaElementSource can only be called once per element,
      // so we disconnect the old source and create a new one
      if (this.sourceNode) {
        this.sourceNode.disconnect();
        this.sourceNode = null;
      }

      const source = this.audioContext.createMediaElementSource(audio);
      source.connect(this.analyser!);
      this.sourceNode = source;
    } catch (err) {
      console.warn("[StreamingTTS] AudioContext setup failed:", err);
    }
  }

  private playBrowserSpeech(
    text: string,
    gen: number,
    onStart?: () => void,
    onEnd?: () => void,
  ): void {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      this.speaking = false;
      this.isBrowserSpeaking = false;
      onEnd?.();
      return;
    }

    // Trigger onStart immediately so the text displays even if audio is blocked
    onStart?.();

    // Cancel any ongoing browser speech
    window.speechSynthesis.cancel();

    this.isBrowserSpeaking = true;
    const utterance = new SpeechSynthesisUtterance(text);
    
    // Attempt to find a nice female English voice (since Mira is a female stylist)
    const voices = window.speechSynthesis.getVoices();
    const voice = voices.find(
      (v) =>
        v.lang.startsWith("en") &&
        (v.name.toLowerCase().includes("female") ||
          v.name.toLowerCase().includes("google") ||
          v.name.toLowerCase().includes("samantha") ||
          v.name.toLowerCase().includes("tessa") ||
          v.name.toLowerCase().includes("moira") ||
          v.name.toLowerCase().includes("karen"))
    );
    if (voice) {
      utterance.voice = voice;
    }
    
    utterance.rate = 1.05;

    let settled = false;
    let safetyTimeout: ReturnType<typeof setTimeout>;

    const done = () => {
      if (settled) return;
      settled = true;
      if (safetyTimeout) {
        clearTimeout(safetyTimeout);
      }
      this.isBrowserSpeaking = false;
      this.speaking = false;
      onEnd?.();
    };

    safetyTimeout = setTimeout(() => {
      console.warn("[StreamingTTS] SpeechSynthesis safety timeout fired — resolving to prevent deadlock");
      done();
    }, Math.max(4000, text.length * 100)); // Character-based scale, min 4s

    utterance.onend = done;
    utterance.onerror = done;

    window.speechSynthesis.speak(utterance);
  }

  /**
   * Get current output volume (0-1) for feeding to the Orb component.
   * Uses the same power-curve normalization as ElevenLabs SDK.
   */
  getOutputVolume(): number {
    if (this.isBrowserSpeaking && this.speaking) {
      // Simulate speech volume fluctuations (0.15 to 0.45)
      return 0.15 + Math.random() * 0.3;
    }
    if (!this.analyser || !this.frequencyData || !this.speaking) return 0;

    this.analyser.getByteFrequencyData(this.frequencyData);

    let sum = 0;
    for (let i = 0; i < this.frequencyData.length; i++) {
      sum += this.frequencyData[i];
    }
    const raw = sum / (this.frequencyData.length * 255);

    // Power-curve normalization (same as ElevenLabs SDK voice-chat blocks)
    return Math.min(1.0, Math.pow(raw, 0.5) * 2.5);
  }

  /** Stop current playback, clear queue, and cancel any in-flight stream. */
  stop(): void {
    this.generation++;
    this.queueGeneration++;
    this.queue = [];
    this.onQueueDrain = undefined;
    this.speaking = false;
    this.isBrowserSpeaking = false;

    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }

    if (this.audio) {
      this.audio.pause();
      if (this.audio.src) {
        URL.revokeObjectURL(this.audio.src);
      }
      this.audio = null;
    }

    if (this.mediaSource?.readyState === "open") {
      try {
        this.mediaSource.endOfStream();
      } catch {
        // Already ended
      }
    }
    this.mediaSource = null;

    if (this.pendingResolve) {
      this.pendingResolve();
      this.pendingResolve = null;
    }
  }

  isSpeaking(): boolean {
    return this.speaking;
  }

  /** Clean up AudioContext on teardown. */
  destroy(): void {
    this.stop();
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    this.analyser = null;
    this.frequencyData = null;
  }
}
