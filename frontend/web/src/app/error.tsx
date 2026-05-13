"use client";

import { useEffect } from "react";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 text-foreground">
      <div className="w-full max-w-md rounded-3xl border border-border/50 bg-card p-6 text-center shadow-panel">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">Luna</p>
        <h1 className="mt-3 text-2xl font-bold">Something went wrong</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">{error.message || "The app could not render this page."}</p>
        <button type="button" onClick={reset} className="mt-5 h-10 rounded-2xl bg-primary px-5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90">
          Try again
        </button>
      </div>
    </main>
  );
}
