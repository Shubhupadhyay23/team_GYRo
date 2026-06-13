"use client";

import { useState } from "react";
import Link from "next/link";

const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL || "not configured";

const SHOW_LAPTOP_MODE = true; // Set to false to remove/hide Laptop Mode anytime

const routes = [
  {
    href: "/chat",
    label: "Chat with Mira",
    description: "Test UI — text-based agent conversation",
  },
  {
    href: "/mirror",
    label: "Mirror Display",
    description: "Full-screen overlay for the two-way mirror",
  },
  {
    href: "/phone",
    label: "Phone Onboarding",
    description: "Google OAuth sign-in and queue flow",
  },
  ...(SHOW_LAPTOP_MODE
    ? [
        {
          href: "/laptop",
          label: "Mirrorless Laptop Mode",
          description: "Test all features standalone",
        },
      ]
    : []),
];

export default function Home() {
  const [hoveredRoute, setHoveredRoute] = useState<string | null>(null);

  return (
    <main
      style={{
        minHeight: "100vh",
        background: `linear-gradient(rgba(10, 10, 10, 0.82), rgba(10, 10, 10, 0.82)), url('/background_static.jpg') no-repeat center center/cover`,
        color: "#e0e0e0",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "'Outfit', 'Inter', system-ui, -apple-system, sans-serif",
        padding: "2rem",
        position: "relative",
        overflow: "hidden",
      }}
    >
      {/* Import premium font */}
      <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;700&display=swap" rel="stylesheet" />

      {/* CSS keyframes for rotation and glow pulsing */}
      <style>{`
        @keyframes rotateChakra {
          0% {
            transform: rotate(0deg);
          }
          100% {
            transform: rotate(360deg);
          }
        }
        @keyframes glowPulse {
          0%, 100% {
            opacity: 0.45;
            filter: drop-shadow(0 0 15px rgba(45, 212, 191, 0.2)) brightness(0.95);
          }
          50% {
            opacity: 0.75;
            filter: drop-shadow(0 0 40px rgba(45, 212, 191, 0.6)) brightness(1.25);
          }
        }
      `}</style>

      {/* Centered Chakra Container */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          pointerEvents: "none",
          zIndex: 0,
          overflow: "hidden",
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/chakra.png"
          alt="Sacred Chakra"
          style={{
            width: "82vh",
            height: "82vh",
            maxWidth: "95vw",
            maxHeight: "95vw",
            objectFit: "contain",
            animation: "rotateChakra 50s linear infinite, glowPulse 10s ease-in-out infinite",
            transformOrigin: "center center",
            willChange: "transform",
          }}
        />
      </div>

      {/* Decorative ambient glow */}
      <div
        style={{
          position: "absolute",
          top: "10%",
          left: "50%",
          transform: "translateX(-50%)",
          width: "400px",
          height: "400px",
          background: "radial-gradient(circle, rgba(100, 140, 255, 0.08) 0%, rgba(0,0,0,0) 70%)",
          pointerEvents: "none",
          zIndex: 0,
        }}
      />

      <div style={{ position: "relative", zIndex: 1, display: "flex", flexDirection: "column", alignItems: "center" }}>
        <h1
          style={{
            fontSize: "3.2rem",
            fontWeight: 700,
            background: "linear-gradient(135deg, #ffffff 0%, #a5b4fc 100%)",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            marginBottom: "0.25rem",
            letterSpacing: "-0.03em",
          }}
        >
          Mirrorless
        </h1>
        <p style={{ color: "rgba(255,255,255,0.45)", marginBottom: "2.5rem", fontSize: "1.05rem", fontWeight: 300, letterSpacing: "0.05em" }}>
          AI-powered smart mirror
        </p>

        <nav
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "1.1rem",
            width: "100%",
            maxWidth: "420px",
          }}
        >
          {routes.map((route) => {
            const isHovered = hoveredRoute === route.href;
            return (
              <Link
                key={route.href}
                href={route.href}
                onMouseEnter={() => setHoveredRoute(route.href)}
                onMouseLeave={() => setHoveredRoute(null)}
                style={{
                  display: "block",
                  padding: "1.2rem 1.5rem",
                  background: isHovered ? "rgba(255, 255, 255, 0.06)" : "rgba(255, 255, 255, 0.025)",
                  backdropFilter: "blur(16px)",
                  WebkitBackdropFilter: "blur(16px)",
                  border: isHovered ? "1px solid rgba(165, 180, 252, 0.35)" : "1px solid rgba(255, 255, 255, 0.08)",
                  borderRadius: "14px",
                  textDecoration: "none",
                  color: "#ffffff",
                  transform: isHovered ? "translateY(-2px)" : "translateY(0)",
                  boxShadow: isHovered 
                    ? "0 12px 30px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.15), 0 0 15px rgba(165, 180, 252, 0.1)"
                    : "0 4px 20px rgba(0, 0, 0, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.05)",
                  transition: "all 0.25s cubic-bezier(0.16, 1, 0.3, 1)",
                }}
              >
                <div 
                  style={{ 
                    fontWeight: 600, 
                    fontSize: "1.1rem", 
                    marginBottom: "0.25rem",
                    color: isHovered ? "#c7d2fe" : "#ffffff",
                    transition: "color 0.2s ease"
                  }}
                >
                  {route.label}
                </div>
                <div style={{ fontSize: "0.88rem", color: "rgba(255,255,255,0.45)" }}>
                  {route.description}
                </div>
              </Link>
            );
          })}
        </nav>

        <div
          style={{
            marginTop: "3rem",
            fontSize: "0.85rem",
            color: "rgba(255, 255, 255, 0.3)",
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
            background: "rgba(255, 255, 255, 0.02)",
            border: "1px solid rgba(255, 255, 255, 0.04)",
            padding: "6px 14px",
            borderRadius: "20px",
            backdropFilter: "blur(4px)",
          }}
        >
          <span
            style={{
              width: "6px",
              height: "6px",
              borderRadius: "50%",
              backgroundColor: "#22c55e",
              display: "inline-block",
              boxShadow: "0 0 8px #22c55e",
            }}
          />
          Socket: {SOCKET_URL}
        </div>
      </div>
    </main>
  );
}
