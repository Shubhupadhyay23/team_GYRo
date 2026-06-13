"use client";

import { useCallback, useEffect, useState, useRef } from "react";
import { socket } from "@/lib/socket";
import { parseEmotionTag } from "@/lib/emotion-parser";

type TestPageState = "start" | "session" | "recap";

interface ChatMessage {
  sender: "user" | "mira";
  text: string;
  isStreaming?: boolean;
}

export default function LaptopTestPage() {
  const [kioskState, setKioskState] = useState<TestPageState>("start");
  const [socketConnected, setSocketConnected] = useState(socket.connected);
  const [userId, setUserId] = useState<string | null>(null);
  const [chatInput, setChatInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStarting, setIsStarting] = useState(false);
  const [recapSummary, setRecapSummary] = useState("");

  const sentenceBufferRef = useRef("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // ── Auto-scroll to bottom of chat ──
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // ── Socket Connection ──
  useEffect(() => {
    socket.connect();
    socket.emit("join_mirror_room");

    const onConnect = () => {
      console.log("[TestPage:Socket] Connected, id:", socket.id);
      setSocketConnected(true);
    };
    const onConnectError = (err: Error) => {
      console.error("[TestPage:Socket] Connection error:", err.message);
      setSocketConnected(false);
    };
    const onDisconnect = (reason: string) => {
      console.warn("[TestPage:Socket] Disconnected:", reason);
      setSocketConnected(false);
    };

    socket.on("connect", onConnect);
    socket.on("connect_error", onConnectError);
    socket.on("disconnect", onDisconnect);

    return () => {
      socket.off("connect", onConnect);
      socket.off("connect_error", onConnectError);
      socket.off("disconnect", onDisconnect);
      socket.disconnect();
    };
  }, []);

  // ── Room Join ──
  useEffect(() => {
    if (userId) {
      socket.emit("join_room", { user_id: userId });
    }
  }, [userId]);

  // ── Session Active event from Backend ──
  useEffect(() => {
    const handleSessionActive = () => {
      setKioskState("session");
      setMessages([]);
      setRecapSummary("");
    };

    socket.on("session_active", handleSessionActive);
    return () => {
      socket.off("session_active", handleSessionActive);
    };
  }, []);

  // ── Mira Speech stream handler ──
  useEffect(() => {
    const handleSpeech = (data: { text?: string; is_chunk?: boolean }) => {
      console.log("[TestPage:Telemetry] 5. Socket received 'mira_speech':", data);

      if (data.is_chunk !== false) {
        if (!data.text) return;
        sentenceBufferRef.current += data.text;
        const currentText = parseEmotionTag(sentenceBufferRef.current).cleanText;

        // Update the last message if it's from Mira and currently streaming
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.sender === "mira" && last.isStreaming) {
            return [
              ...prev.slice(0, -1),
              { sender: "mira", text: currentText, isStreaming: true }
            ];
          } else {
            return [
              ...prev,
              { sender: "mira", text: currentText, isStreaming: true }
            ];
          }
        });
      } else {
        // End of message
        if (data.text) {
          sentenceBufferRef.current += data.text;
        }
        const finalText = parseEmotionTag(sentenceBufferRef.current).cleanText;
        sentenceBufferRef.current = "";

        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.sender === "mira" && last.isStreaming) {
            return [
              ...prev.slice(0, -1),
              { sender: "mira", text: finalText, isStreaming: false }
            ];
          } else {
            return [
              ...prev,
              { sender: "mira", text: finalText, isStreaming: false }
            ];
          }
        });
      }
    };

    socket.on("mira_speech", handleSpeech);
    return () => {
      socket.off("mira_speech", handleSpeech);
    };
  }, []);


  // ── Session Ended event from Backend ──
  useEffect(() => {
    const handleSessionEnded = (data?: { summary?: string }) => {
      setKioskState("recap");
      setRecapSummary(data?.summary || "Your styling session is finished.");
      setUserId(null);
    };

    socket.on("session_ended", handleSessionEnded);
    return () => {
      socket.off("session_ended", handleSessionEnded);
    };
  }, []);

  // ── Start Session Action ──
  const handleStartSession = useCallback(async () => {
    if (isStarting || kioskState === "session") return;
    setIsStarting(true);

    try {
      const apiHost = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
      let resolvedApiUrl = apiHost;
      if (typeof window !== "undefined") {
        const socketUrl = process.env.NEXT_PUBLIC_SOCKET_URL;
        if (window.location.protocol === "https:" && socketUrl && socketUrl.startsWith("https:")) {
          resolvedApiUrl = socketUrl;
        } else if (apiHost.includes("localhost")) {
          resolvedApiUrl = apiHost.replace("localhost", window.location.hostname);
        } else if (apiHost.includes("127.0.0.1")) {
          resolvedApiUrl = apiHost.replace("127.0.0.1", window.location.hostname);
        }
      }
      resolvedApiUrl = resolvedApiUrl.replace(/\/$/, "");
      
      const res = await fetch(`${resolvedApiUrl}/laptop/guest`, {
        method: "POST"
      });
      const data = await res.json();
      if (!data.user_id) throw new Error("No user_id returned");

      setUserId(data.user_id);
      socket.emit("start_session", { user_id: data.user_id });
    } catch (e) {
      console.error("[TestPage] Failed to start guest session:", e);
      alert("Failed to connect to backend api. Please make sure the backend server is running.");
    } finally {
      setIsStarting(false);
    }
  }, [isStarting, kioskState]);

  // ── Send Message Action ──
  const sendMessage = useCallback(() => {
    if (!chatInput.trim() || !userId) return;
    const text = chatInput.trim();
    setChatInput("");

    // Append user message locally
    setMessages((prev) => [...prev, { sender: "user", text }]);
    console.log("[TestPage:Telemetry] 1. Sent chat message:", text);

    socket.emit("mirror_event", {
      user_id: userId,
      event: { type: "voice", transcript: text }
    });
  }, [chatInput, userId]);

  // ── End Session Action ──
  const handleEndSession = useCallback(() => {
    if (!userId) return;
    socket.emit("end_session", { user_id: userId });
  }, [userId]);

  return (
    <main
      style={{
        width: "100vw",
        height: "100vh",
        background: "#090a10",
        color: "#f3f4f6",
        fontFamily: "'Outfit', sans-serif",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        position: "relative",
        overflow: "hidden",
      }}
    >
      {/* Visual Socket connection dot (top-left) */}
      <div
        style={{
          position: "absolute",
          top: 24,
          left: 24,
          display: "flex",
          alignItems: "center",
          gap: 8,
          background: "rgba(255, 255, 255, 0.03)",
          backdropFilter: "blur(12px)",
          padding: "6px 12px",
          borderRadius: 20,
          border: "1px solid rgba(255, 255, 255, 0.08)",
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: socketConnected ? "#10B981" : "#EF4444",
            boxShadow: socketConnected ? "0 0 8px #10B981" : "0 0 8px #EF4444",
          }}
        />
        <span style={{ fontSize: "0.75rem", fontWeight: 500, color: "rgba(255, 255, 255, 0.7)" }}>
          {socketConnected ? "Connected" : "Disconnected"}
        </span>
      </div>

      {/* Title */}
      <div style={{ position: "absolute", top: 24, right: 24 }}>
        <h2 style={{ fontSize: "0.9rem", fontWeight: 600, letterSpacing: "0.05em", color: "rgba(255, 255, 255, 0.4)", textTransform: "uppercase" }}>
          Lightweight Diagnostic Page
        </h2>
      </div>

      {/* START STATE */}
      {kioskState === "start" && (
        <div style={{ textAlign: "center", maxWidth: 400, padding: 24, zIndex: 10 }}>
          <h1 style={{ fontSize: "2.5rem", fontWeight: 700, marginBottom: 12, background: "linear-gradient(135deg, #a5b4fc, #818cf8)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
            Mira MVC Diagnostic
          </h1>
          <p style={{ color: "rgba(255, 255, 255, 0.5)", fontSize: "0.95rem", marginBottom: 32, lineHeight: "1.5" }}>
            This page executes socket actions with <strong>zero</strong> camera hooks, pose calculations, or heavy dependencies. Perfect for testing backend connection stability.
          </p>
          <button
            onClick={handleStartSession}
            disabled={isStarting}
            style={{
              padding: "14px 36px",
              fontSize: "1rem",
              fontWeight: 600,
              color: "#fff",
              background: isStarting ? "rgba(255,255,255,0.05)" : "linear-gradient(135deg, #4f46e5 0%, #3b82f6 100%)",
              border: "none",
              borderRadius: "10px",
              cursor: isStarting ? "default" : "pointer",
              boxShadow: "0 4px 15px rgba(79, 70, 229, 0.3)",
              transition: "all 0.2s ease",
            }}
          >
            {isStarting ? "Creating Session..." : "Start Diagnostic Session"}
          </button>
        </div>
      )}

      {/* SESSION STATE */}
      {kioskState === "session" && (
        <div
          style={{
            width: "90%",
            maxWidth: 550,
            height: "75vh",
            background: "rgba(255, 255, 255, 0.02)",
            border: "1px solid rgba(255, 255, 255, 0.06)",
            borderRadius: 16,
            display: "flex",
            flexDirection: "column",
            zIndex: 10,
            boxShadow: "0 20px 40px rgba(0,0,0,0.5)",
          }}
        >
          {/* Header */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 20px", borderBottom: "1px solid rgba(255, 255, 255, 0.06)" }}>
            <div>
              <h3 style={{ fontSize: "1rem", fontWeight: 600 }}>Styling with Mira</h3>
              <span style={{ fontSize: "0.75rem", color: "rgba(255,255,255,0.4)" }}>Guest Session</span>
            </div>
            <button
              onClick={handleEndSession}
              style={{
                fontSize: "0.8rem",
                color: "rgba(255,255,255,0.5)",
                background: "rgba(255,255,255,0.05)",
                border: "1px solid rgba(255,255,255,0.1)",
                padding: "6px 12px",
                borderRadius: 6,
                cursor: "pointer",
              }}
            >
              End Session
            </button>
          </div>

          {/* Messages list */}
          <div style={{ flex: 1, overflowY: "auto", padding: "20px", display: "flex", flexDirection: "column", gap: 14 }}>
            {messages.map((m, idx) => (
              <div
                key={idx}
                style={{
                  alignSelf: m.sender === "user" ? "flex-end" : "flex-start",
                  maxWidth: "80%",
                  background: m.sender === "user" ? "linear-gradient(135deg, #312e81 0%, #1e1b4b 100%)" : "rgba(255,255,255,0.04)",
                  border: m.sender === "user" ? "1px solid rgba(99,102,241,0.2)" : "1px solid rgba(255,255,255,0.08)",
                  borderRadius: m.sender === "user" ? "14px 14px 2px 14px" : "14px 14px 14px 2px",
                  padding: "10px 14px",
                  fontSize: "0.9rem",
                  lineHeight: "1.4",
                }}
              >
                {m.text}
                {m.isStreaming && <span style={{ display: "inline-block", width: 4, height: 14, background: "#818cf8", marginLeft: 4, animation: "blink 1s step-end infinite" }} />}
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>

          {/* Footer input form */}
          <div style={{ padding: 16, borderTop: "1px solid rgba(255, 255, 255, 0.06)" }}>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    sendMessage();
                  }
                }}
                placeholder="Ask Mira something (e.g. streetwear, date night)..."
                style={{
                  flex: 1,
                  background: "rgba(255,255,255,0.03)",
                  border: "1px solid rgba(255,255,255,0.08)",
                  borderRadius: 8,
                  padding: "10px 14px",
                  color: "#fff",
                  outline: "none",
                  fontSize: "0.9rem",
                }}
              />
              <button
                onClick={sendMessage}
                disabled={!chatInput.trim()}
                style={{
                  background: chatInput.trim() ? "linear-gradient(135deg, #4f46e5 0%, #3730a3 100%)" : "rgba(255,255,255,0.02)",
                  border: "none",
                  borderRadius: 8,
                  padding: "10px 20px",
                  color: "#fff",
                  fontWeight: 600,
                  fontSize: "0.85rem",
                  cursor: chatInput.trim() ? "pointer" : "default",
                }}
              >
                Send
              </button>
            </div>
          </div>
        </div>
      )}

      {/* RECAP STATE */}
      {kioskState === "recap" && (
        <div style={{ textAlign: "center", maxWidth: 450, padding: 24, zIndex: 10 }}>
          <h1 style={{ fontSize: "2rem", fontWeight: 700, marginBottom: 12 }}>Session Complete</h1>
          <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 12, padding: 20, marginBottom: 24, lineHeight: "1.5", fontSize: "0.95rem" }}>
            {recapSummary}
          </div>
          <button
            onClick={() => setKioskState("start")}
            style={{
              padding: "12px 30px",
              fontSize: "0.9rem",
              fontWeight: 600,
              color: "#fff",
              background: "rgba(255,255,255,0.06)",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: "8px",
              cursor: "pointer",
            }}
          >
            Start New Test
          </button>
        </div>
      )}

      <style>{`
        @keyframes blink {
          50% { opacity: 0; }
        }
      `}</style>
    </main>
  );
}
