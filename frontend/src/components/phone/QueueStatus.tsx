"use client";

import { useEffect, useState, useRef } from "react";
import { getQueueStatus, joinQueue, leaveQueue, QueueInfo } from "@/lib/api";

interface QueueStatusProps {
  userId: string;
  onBecameActive?: () => void;
  onLeave?: () => void;
}

export default function QueueStatus({ userId, onBecameActive, onLeave }: QueueStatusProps) {
  const [queue, setQueue] = useState<QueueInfo | null>(null);
  const [error, setError] = useState("");
  const [leaving, setLeaving] = useState(false);
  const firedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval>;

    async function init() {
      try {
        const info = await joinQueue(userId);
        if (!cancelled) setQueue(info);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to join queue");
      }
    }

    init();

    // Poll every 5 seconds
    timer = setInterval(async () => {
      try {
        const info = await getQueueStatus(userId);
        if (!cancelled) setQueue(info);
      } catch {
        // Ignore polling errors
      }
    }, 5000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [userId]);

  // Fire onBecameActive exactly once
  useEffect(() => {
    if (queue?.status === "active" && !firedRef.current && onBecameActive) {
      firedRef.current = true;
      onBecameActive();
    }
  }, [queue?.status, onBecameActive]);

  async function handleLeave() {
    setLeaving(true);
    try {
      await leaveQueue(userId);
      onLeave?.();
    } catch {
      setLeaving(false);
      setError("Failed to leave queue. Please try again.");
    }
  }

  if (error) {
    return (
      <div className="text-center text-red-400 font-medium">
        <p>{error}</p>
      </div>
    );
  }

  if (!queue) {
    return (
      <div className="text-center text-zinc-400 animate-pulse">
        <p>Joining the queue...</p>
      </div>
    );
  }

  if (queue.status === "active") {
    return (
      <div className="flex flex-col items-center gap-3">
        <div className="w-14 h-14 rounded-full bg-gradient-to-tr from-emerald-500 to-green-600 flex items-center justify-center text-white text-2xl shadow-[0_0_15px_rgba(16,185,129,0.4)] animate-bounce">
          ✓
        </div>
        <h2 className="text-xl font-bold text-white">It&apos;s your turn!</h2>
        <p className="text-zinc-300 text-sm text-center">Head to the mirror to begin your session.</p>
        <button
          onClick={handleLeave}
          disabled={leaving}
          className="mt-2 text-xs text-zinc-400 hover:text-zinc-200 transition-colors disabled:opacity-50 underline"
        >
          {leaving ? "Leaving..." : "Leave Queue"}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-4">
      <h2 className="text-lg font-bold text-white">You&apos;re in the queue</h2>
      <div 
        className="w-18 h-18 rounded-full bg-indigo-950/40 border border-indigo-500/20 flex items-center justify-center text-3xl font-bold text-indigo-300 shadow-[inset_0_1px_3px_rgba(0,0,0,0.4)]" 
        style={{ width: 72, height: 72 }}
      >
        {queue.position}
      </div>
      <div className="text-center">
        <p className="text-zinc-300 text-sm font-medium">
          {queue.total_ahead === 0
            ? "You're next! Hang tight."
            : `${queue.total_ahead} ${queue.total_ahead === 1 ? "person" : "people"} ahead of you`}
        </p>
        <p className="text-zinc-500 text-xs mt-1">
          This page updates automatically.
        </p>
      </div>
      <button
        onClick={handleLeave}
        disabled={leaving}
        className="mt-1 text-xs text-zinc-400 hover:text-zinc-200 transition-colors disabled:opacity-50 underline"
      >
        {leaving ? "Leaving..." : "Leave Queue"}
      </button>
    </div>
  );
}
