"use client";

import { useEffect } from "react";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en" data-theme="dark" className="dark">
      <body style={{ margin: 0, background: "#050505", color: "#f7f7f7", fontFamily: "Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}>
        <main style={{ display: "flex", minHeight: "100vh", alignItems: "center", justifyContent: "center", padding: "1rem" }}>
          <div style={{ width: "100%", maxWidth: "28rem", border: "1px solid rgb(63 63 70 / 0.65)", borderRadius: "1.5rem", background: "#111", padding: "1.5rem", textAlign: "center", boxShadow: "0 24px 80px rgba(0, 0, 0, 0.28)" }}>
            <p style={{ margin: 0, fontSize: "0.75rem", fontWeight: 700, letterSpacing: "0.2em", color: "#a1a1aa", textTransform: "uppercase" }}>Luna</p>
            <h1 style={{ margin: "0.75rem 0 0", fontSize: "1.5rem", fontWeight: 700 }}>Application error</h1>
            <p style={{ margin: "0.75rem 0 0", color: "#a1a1aa", fontSize: "0.875rem", lineHeight: 1.6 }}>{error.message || "The application failed to start."}</p>
            <button type="button" onClick={reset} style={{ marginTop: "1.25rem", height: "2.5rem", border: 0, borderRadius: "1rem", background: "#f7f7f7", color: "#050505", padding: "0 1.25rem", fontSize: "0.875rem", fontWeight: 600, cursor: "pointer" }}>
              Reload Luna
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
