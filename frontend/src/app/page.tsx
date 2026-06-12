"use client";

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
  return (
    <main
      style={{
        minHeight: "100vh",
        backgroundColor: "#0a0a0a",
        color: "#e0e0e0",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "system-ui, -apple-system, sans-serif",
        padding: "2rem",
      }}
    >
      <h1
        style={{
          fontSize: "2.5rem",
          fontWeight: 700,
          color: "#ffffff",
          marginBottom: "0.25rem",
        }}
      >
        Mirrorless
      </h1>
      <p style={{ color: "#888", marginBottom: "2.5rem", fontSize: "1rem" }}>
        AI-powered smart mirror
      </p>

      <nav
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "1rem",
          width: "100%",
          maxWidth: "400px",
        }}
      >
        {routes.map((route) => (
          <Link
            key={route.href}
            href={route.href}
            style={{
              display: "block",
              padding: "1rem 1.25rem",
              backgroundColor: "#1a1a1a",
              border: "1px solid #333",
              borderRadius: "8px",
              textDecoration: "none",
              color: "#e0e0e0",
              transition: "border-color 0.15s",
            }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.borderColor = "#666")
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.borderColor = "#333")
            }
          >
            <div style={{ fontWeight: 600, fontSize: "1.05rem", marginBottom: "0.25rem" }}>
              {route.label}
            </div>
            <div style={{ fontSize: "0.85rem", color: "#888" }}>
              {route.description}
            </div>
          </Link>
        ))}
      </nav>

      <div
        style={{
          marginTop: "2.5rem",
          fontSize: "0.8rem",
          color: "#555",
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
        }}
      >
        <span
          style={{
            width: "8px",
            height: "8px",
            borderRadius: "50%",
            backgroundColor: "#555",
            display: "inline-block",
          }}
        />
        Socket: {SOCKET_URL}
      </div>
    </main>
  );
}
