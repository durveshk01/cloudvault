"use client";

import React from "react";
import { RefreshCw, WifiOff } from "lucide-react";

interface LoadErrorProps {
  onRetry: () => void;
  isRetrying?: boolean;
  message?: string;
}

export function LoadError({
  onRetry,
  isRetrying = false,
  message = "We couldn't load this information. Check your connection and try again.",
}: LoadErrorProps) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-red-200 bg-red-50/70 px-5 py-12 text-center dark:border-red-900/60 dark:bg-red-950/20"
    >
      <div className="flex h-11 w-11 items-center justify-center rounded-full bg-red-100 text-red-600 dark:bg-red-950/60 dark:text-red-400">
        <WifiOff className="h-5 w-5" aria-hidden="true" />
      </div>
      <div>
        <h2 className="text-sm font-semibold text-foreground">Unable to load data</h2>
        <p className="mt-1 max-w-md text-xs text-muted-foreground">{message}</p>
      </div>
      <button
        type="button"
        onClick={onRetry}
        disabled={isRetrying}
        className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3.5 py-2 text-xs font-semibold text-foreground shadow-sm transition-colors hover:bg-accent disabled:cursor-wait disabled:opacity-60"
      >
        <RefreshCw className={`h-3.5 w-3.5 ${isRetrying ? "animate-spin" : ""}`} aria-hidden="true" />
        Try again
      </button>
    </div>
  );
}
