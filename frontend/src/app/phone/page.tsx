"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { socket } from "@/lib/socket";
import {
  getUser,
  updateProfile,
  uploadSelfie,
  startScrape,
  submitOnboarding,
  UserProfile,
  signup,
  login,
} from "@/lib/api";
import type { OnboardingData } from "@/lib/types";

import SelfieCapture from "@/components/phone/SelfieCapture";
import QueueStatus from "@/components/phone/QueueStatus";
import PhoneInput from "@/components/phone/PhoneInput";

type PhoneState = "loading" | "signin" | "questionnaire" | "queue" | "idle" | "recap";

const STORAGE_KEY = "mirrorless_user_id";

export default function PhonePage() {
  const [state, setState] = useState<PhoneState>("loading");
  const [user, setUser] = useState<UserProfile | null>(null);
  const [error, setError] = useState("");
  const [recapData, setRecapData] = useState<{
    summary?: string;
    items_shown?: number;
    items_liked?: number;
  }>({});

  // Shape of the actual session_ended payload from backend
  interface SessionEndedPayload {
    summary?: string;
    stats?: { items_shown: number; likes: number; dislikes: number };
    liked_items?: Array<{ title: string; price?: string; image_url?: string }>;
    user_name?: string;
  }

  // Check for returning user on mount
  useEffect(() => {
    async function checkReturning() {
      const savedId = localStorage.getItem(STORAGE_KEY);
      if (savedId) {
        try {
          const existingUser = await getUser(savedId);
          setUser(existingUser);
          setState("queue");
          return;
        } catch {
          localStorage.removeItem(STORAGE_KEY);
        }
      }
      setState("signin");
    }
    checkReturning();
  }, []);

  // Connect socket when we have a user
  useEffect(() => {
    if (!user) return;
    socket.connect();
    socket.emit("join_room", { user_id: user.id });

    const handleSessionEnded = (data: SessionEndedPayload) => {
      setRecapData({
        summary: data?.summary,
        items_shown: data?.stats?.items_shown,
        items_liked: data?.stats?.likes,
      });
      setState("recap");
    };

    socket.on("session_ended", handleSessionEnded);

    return () => {
      socket.off("session_ended", handleSessionEnded);
    };
  }, [user]);

  const handleSignInComplete = useCallback(
    (profile: UserProfile, selfieBase64: string | null, displayName: string, phone: string) => {
      setUser(profile);
      localStorage.setItem(STORAGE_KEY, profile.id);

      // Fire-and-forget: update name and phone, upload selfie, start scrape
      updateProfile(profile.id, displayName, phone).catch(() => {});
      if (selfieBase64) {
        uploadSelfie(profile.id, selfieBase64).catch(() => {});
      }
      startScrape(profile.id).catch(() => {});

      setState("questionnaire");
    },
    []
  );

  const handleQuestionnaireSubmit = useCallback(
    async (data: OnboardingData) => {
      if (!user) return;
      await submitOnboarding(user.id, data);
      setState("queue");
    },
    [user]
  );

  const handleBecameActive = useCallback(() => {
    setState("idle");
  }, []);

  const handleLeaveQueue = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setUser(null);
    setState("signin");
  }, []);

  const handleDone = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setUser(null);
    setRecapData({});
    setState("signin");
  }, []);

  if (state === "loading") {
    return (
      <main
        className="min-h-screen flex items-center justify-center text-white"
        style={{
          background: `linear-gradient(rgba(10, 10, 10, 0.85), rgba(10, 10, 10, 0.85)), url('/background.jpg') no-repeat center center/cover`,
          fontFamily: "'Outfit', 'Inter', system-ui, -apple-system, sans-serif",
        }}
      >
        <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;700&display=swap" rel="stylesheet" />
        <p className="text-zinc-400 animate-pulse">Loading...</p>
      </main>
    );
  }

  return (
    <main
      className="min-h-screen text-white flex flex-col items-center justify-center p-4 relative overflow-hidden"
      style={{
        background: `linear-gradient(rgba(10, 10, 10, 0.85), rgba(10, 10, 10, 0.85)), url('/background.jpg') no-repeat center center/cover`,
        fontFamily: "'Outfit', 'Inter', system-ui, -apple-system, sans-serif",
      }}
    >
      <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;700&display=swap" rel="stylesheet" />
      {state === "signin" && (
        <SignInView onComplete={handleSignInComplete} error={error} setError={setError} />
      )}
      {state === "questionnaire" && (
        <QuestionnaireView onSubmit={handleQuestionnaireSubmit} />
      )}
      {state === "queue" && user && (
        <div className="w-full max-w-md bg-white/[0.03] backdrop-blur-xl border border-white/[0.08] rounded-2xl p-6 md:p-8 flex flex-col items-center justify-center shadow-2xl relative z-10">
          <QueueStatus userId={user.id} onBecameActive={handleBecameActive} onLeave={handleLeaveQueue} />
        </div>
      )}
      {state === "idle" && <IdleView />}
      {state === "recap" && (
        <RecapView data={recapData} onDone={handleDone} />
      )}
    </main>
  );
}

/* ---------- SignIn View ---------- */

function SignInView({
  onComplete,
  error,
  setError,
}: {
  onComplete: (user: UserProfile, selfie: string | null, name: string, phone: string) => void;
  error: string;
  setError: (e: string) => void;
}) {
  const [isLogin, setIsLogin] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [phone, setPhone] = useState("");
  const [phoneError, setPhoneError] = useState("");
  const [selfie, setSelfie] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = useCallback(async () => {
    if (!email.trim() || !password.trim()) {
      setError("Email and password are required.");
      return;
    }
    if (!isLogin && !name.trim()) {
      setError("Please enter your name.");
      return;
    }
    
    setPhoneError("");
    setError("");
    setLoading(true);

    try {
      let user: UserProfile;
      if (isLogin) {
        user = await login(email.trim(), password);
      } else {
        user = await signup(name.trim(), email.trim(), password, phone.trim());
      }
      onComplete(user, selfie, user.name || name.trim(), user.phone || phone.trim());
    } catch (err: any) {
      setError(err.message || "Authentication failed");
    } finally {
      setLoading(false);
    }
  }, [isLogin, email, password, name, phone, selfie, onComplete, setError]);

  return (
    <div className="w-full max-w-sm bg-white/[0.03] backdrop-blur-xl border border-white/[0.08] rounded-2xl p-6 md:p-8 flex flex-col gap-4 shadow-2xl relative z-10">
      <div className="text-center mb-1">
        <h1 className="text-2xl font-bold mb-1 bg-gradient-to-r from-white to-zinc-400 bg-clip-text text-transparent">Mirrorless</h1>
        <p className="text-zinc-400 text-sm">Your AI stylist awaits</p>
      </div>

      {!isLogin && <SelfieCapture onCapture={setSelfie} />}

      {!isLogin && (
        <div className="w-full">
          <label className="block text-xs font-semibold mb-1 text-zinc-300">Your name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Enter your name"
            className="w-full px-3 py-2.5 bg-white/5 border border-white/10 rounded-xl text-sm text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-400 transition-all"
          />
        </div>
      )}

      <div className="w-full">
        <label className="block text-xs font-semibold mb-1 text-zinc-300">Email</label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="your@email.com"
          className="w-full px-3 py-2.5 bg-white/5 border border-white/10 rounded-xl text-sm text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-400 transition-all"
        />
      </div>

      <div className="w-full">
        <label className="block text-xs font-semibold mb-1 text-zinc-300">Password</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
          className="w-full px-3 py-2.5 bg-white/5 border border-white/10 rounded-xl text-sm text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-400 transition-all"
        />
      </div>

      {!isLogin && (
        <div className="w-full">
          <PhoneInput
            value={phone}
            onChange={setPhone}
            error={phoneError}
          />
        </div>
      )}

      <button
        onClick={handleSubmit}
        disabled={loading}
        className="w-full bg-gradient-to-r from-indigo-600 to-violet-700 hover:from-indigo-500 hover:to-violet-600 text-white rounded-xl py-3 text-sm font-semibold disabled:opacity-50 transition-all shadow-[0_4px_15px_rgba(99,102,241,0.2)] hover:shadow-[0_4px_20px_rgba(99,102,241,0.4)]"
      >
        {loading ? "Please wait..." : isLogin ? "Log In" : "Sign Up"}
      </button>

      {error && <p className="text-red-400 text-sm text-center font-medium mt-1">{error}</p>}
      
      <button 
        onClick={() => { setIsLogin(!isLogin); setError(""); }}
        className="text-sm text-zinc-400 hover:text-white underline mt-2 transition-colors self-center"
      >
        {isLogin ? "Need an account? Sign up" : "Already have an account? Log in"}
      </button>
    </div>
  );
}

/* ---------- Questionnaire View ---------- */

const STYLE_OPTIONS = [
  "Casual", "Streetwear", "Minimalist", "Preppy",
  "Athleisure", "Vintage", "Smart Casual", "Bohemian",
];

const OCCASION_OPTIONS = [
  "Everyday", "Work", "Date Night", "Workout", "Weekend", "Travel",
];

function QuestionnaireView({
  onSubmit,
}: {
  onSubmit: (data: OnboardingData) => void;
}) {
  const [brands, setBrands] = useState("");
  const [styles, setStyles] = useState<string[]>([]);
  const [occasions, setOccasions] = useState<string[]>([]);
  const [gender, setGender] = useState("unspecified");
  const [priceMin, setPriceMin] = useState(0);
  const [priceMax, setPriceMax] = useState(300);

  function toggle(arr: string[], val: string, setter: (v: string[]) => void) {
    setter(arr.includes(val) ? arr.filter((x) => x !== val) : [...arr, val]);
  }

  function handleSubmit() {
    onSubmit({
      favorite_brands: brands.split(",").map((b) => b.trim()).filter(Boolean),
      style_preferences: styles,
      price_range: { min: priceMin, max: priceMax },
      size_info: {},
      gender,
      occasions,
    });
  }

  return (
    <div className="w-full max-w-md bg-white/[0.03] backdrop-blur-xl border border-white/[0.08] rounded-2xl p-6 md:p-8 flex flex-col gap-4 shadow-2xl relative z-10">
      <div>
        <h2 className="text-xl font-bold mb-0.5 text-white">Let&apos;s get to know you</h2>
        <p className="text-zinc-400 text-xs">
          Quick style questions to personalize your experience.
        </p>
      </div>

      {/* Gender */}
      <div>
        <label className="block text-xs font-semibold mb-1 text-zinc-300">Gender</label>
        <select
          value={gender}
          onChange={(e) => setGender(e.target.value)}
          className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-400 [&>option]:bg-zinc-950 [&>option]:text-white transition-all"
        >
          <option value="mens">Men</option>
          <option value="womens">Women</option>
          <option value="unspecified">Prefer not to say</option>
        </select>
      </div>

      {/* Brands */}
      <div>
        <label className="block text-xs font-semibold mb-1 text-zinc-300">
          Favorite brands (comma-separated)
        </label>
        <input
          value={brands}
          onChange={(e) => setBrands(e.target.value)}
          placeholder="Nike, Zara, Uniqlo"
          className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-400 transition-all"
        />
      </div>

      {/* Style */}
      <div>
        <label className="block text-xs font-semibold mb-1.5 text-zinc-300">Style preferences</label>
        <div className="flex flex-wrap gap-1.5">
          {STYLE_OPTIONS.map((s) => (
            <button
              key={s}
              onClick={() => toggle(styles, s, setStyles)}
              className={`px-3 py-1.5 rounded-full text-xs border transition-all ${
                styles.includes(s)
                  ? "bg-indigo-600 text-white border-indigo-500 shadow-[0_2px_8px_rgba(99,102,241,0.4)]"
                  : "bg-white/5 text-zinc-300 border-white/10 hover:border-white/30 hover:bg-white/10"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* Occasions */}
      <div>
        <label className="block text-xs font-semibold mb-1.5 text-zinc-300 font-sans">Occasions</label>
        <div className="flex flex-wrap gap-1.5">
          {OCCASION_OPTIONS.map((o) => (
            <button
              key={o}
              onClick={() => toggle(occasions, o, setOccasions)}
              className={`px-3 py-1.5 rounded-full text-xs border transition-all ${
                occasions.includes(o)
                  ? "bg-indigo-600 text-white border-indigo-500 shadow-[0_2px_8px_rgba(99,102,241,0.4)]"
                  : "bg-white/5 text-zinc-300 border-white/10 hover:border-white/30 hover:bg-white/10"
              }`}
            >
              {o}
            </button>
          ))}
        </div>
      </div>

      {/* Price range */}
      <div>
        <label className="block text-xs font-semibold mb-1.5 text-zinc-300">
          Price range: ${priceMin} – ${priceMax}
        </label>
        <div className="flex gap-3 items-center">
          <input
            type="range"
            min={0}
            max={500}
            step={10}
            value={priceMin}
            onChange={(e) => setPriceMin(Number(e.target.value))}
            className="flex-1 accent-indigo-500"
          />
          <input
            type="range"
            min={0}
            max={500}
            step={10}
            value={priceMax}
            onChange={(e) => setPriceMax(Number(e.target.value))}
            className="flex-1 accent-indigo-500"
          />
        </div>
      </div>

      <button
        onClick={handleSubmit}
        className="w-full bg-gradient-to-r from-indigo-600 to-violet-700 hover:from-indigo-500 hover:to-violet-600 text-white rounded-xl py-3 text-sm font-semibold transition-all shadow-[0_4px_15px_rgba(99,102,241,0.2)] hover:shadow-[0_4px_20px_rgba(99,102,241,0.4)]"
      >
        Join Queue
      </button>
    </div>
  );
}

/* ---------- Idle View ---------- */

const TIPS = [
  "Try saying: \"I want something for a night out\"",
  "Give a thumbs up to save items you like",
  "Swipe left or right to browse outfits",
  "Ask Mira about your style or upcoming events",
];

function IdleView() {
  const [tipIndex, setTipIndex] = useState(0);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const tipTimer = setInterval(() => {
      setTipIndex((i) => (i + 1) % TIPS.length);
    }, 5000);
    const clockTimer = setInterval(() => {
      setElapsed((s) => s + 1);
    }, 1000);
    return () => {
      clearInterval(tipTimer);
      clearInterval(clockTimer);
    };
  }, []);

  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;

  return (
    <div className="w-full max-w-sm bg-white/[0.03] backdrop-blur-xl border border-white/[0.08] rounded-2xl p-6 md:p-8 flex flex-col items-center gap-4 shadow-2xl relative z-10">
      <div className="w-14 h-14 rounded-full bg-gradient-to-tr from-indigo-500 to-violet-600 flex items-center justify-center shadow-[0_0_15px_rgba(99,102,241,0.5)]">
        <span className="text-white text-2xl animate-pulse">✦</span>
      </div>

      <h2 className="text-xl font-bold text-center text-white">
        You&apos;re at the mirror!
      </h2>

      <div className="h-10 flex items-center">
        <p className="text-zinc-400 text-center text-xs animate-pulse transition-all">
          {TIPS[tipIndex]}
        </p>
      </div>

      <div className="text-indigo-300 text-xs font-mono bg-indigo-950/40 border border-indigo-500/20 px-3 py-1.5 rounded-lg shadow-[inset_0_1px_3px_rgba(0,0,0,0.4)]">
        {String(minutes).padStart(2, "0")}:{String(seconds).padStart(2, "0")}
      </div>
    </div>
  );
}

/* ---------- Recap View ---------- */

function RecapView({
  data,
  onDone,
}: {
  data: { summary?: string; items_shown?: number; items_liked?: number };
  onDone: () => void;
}) {
  return (
    <div className="w-full max-w-sm bg-white/[0.03] backdrop-blur-xl border border-white/[0.08] rounded-2xl p-6 md:p-8 flex flex-col items-center gap-5 shadow-2xl relative z-10">
      <h2 className="text-xl font-bold text-white">Session Complete</h2>

      {data.summary && (
        <p className="text-zinc-300 text-center text-sm leading-relaxed max-w-sm">{data.summary}</p>
      )}

      <div className="flex gap-10 my-1">
        {data.items_shown !== undefined && (
          <div className="text-center">
            <p className="text-3xl font-bold text-white bg-gradient-to-r from-white to-zinc-400 bg-clip-text text-transparent">{data.items_shown}</p>
            <p className="text-xs text-zinc-400 mt-1 uppercase tracking-wider">Items Shown</p>
          </div>
        )}
        {data.items_liked !== undefined && (
          <div className="text-center">
            <p className="text-3xl font-bold text-indigo-300 bg-gradient-to-r from-indigo-300 to-violet-300 bg-clip-text text-transparent">{data.items_liked}</p>
            <p className="text-xs text-zinc-400 mt-1 uppercase tracking-wider">Liked</p>
          </div>
        )}
      </div>

      {process.env.NEXT_PUBLIC_POKE_RECIPE_URL && (
        <a
          href={process.env.NEXT_PUBLIC_POKE_RECIPE_URL}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: "block",
            width: "100%",
            padding: "12px 20px",
            fontSize: 14,
            fontWeight: 600,
            color: "#fff",
            background: "linear-gradient(135deg, #4f46e5 0%, #3730a3 100%)",
            border: "none",
            borderRadius: 12,
            textAlign: "center",
            textDecoration: "none",
            boxSizing: "border-box",
            boxShadow: "0 4px 15px rgba(99, 102, 241, 0.2)",
          }}
        >
          Continue on Poke
        </a>
      )}

      <button
        onClick={onDone}
        className="w-full bg-white/5 border border-white/10 hover:bg-white/10 text-white rounded-xl py-3 text-sm font-semibold transition-all"
      >
        Done
      </button>
    </div>
  );
}
