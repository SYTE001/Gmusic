import type { LyricCapabilityLevel } from "./capability";
import type { LyricsProvider } from "./lyricsService";

export type ProviderDiagnostic = {
  provider: LyricsProvider;
  startedAt: number;
  durationMs: number;
  status: number | string;
  recordsReturned: number;
  usableLyricsPayloads: number;
  bestScore?: number | null;
  rejectionReason?: string | null;
  error?: string;
};

export type LyricsSearchDiagnostic = {
  trackId: string;
  title: string;
  artist: string;
  album?: string;
  durationSeconds?: number;
  totalDurationMs: number;
  providers: Partial<Record<LyricsProvider, ProviderDiagnostic>>;
  finalSelectedProvider: LyricsProvider | "cached" | "none";
  finalCapability: LyricCapabilityLevel;
};

let latestDiagnostic: LyricsSearchDiagnostic | null = null;
const diagnosticHistory: LyricsSearchDiagnostic[] = [];
const MAX_HISTORY = 20;

export function recordSearchDiagnostic(diagnostic: LyricsSearchDiagnostic): void {
  latestDiagnostic = diagnostic;
  diagnosticHistory.push(diagnostic);
  if (diagnosticHistory.length > MAX_HISTORY) {
    diagnosticHistory.shift();
  }

  // Developer console diagnostic log (never exposes secrets or tokens)
  if (typeof console !== "undefined" && typeof console.info === "function") {
    console.info(`[LyricsDiagnostics] ${diagnostic.artist} - ${diagnostic.title}`, {
      selectedProvider: diagnostic.finalSelectedProvider,
      capability: diagnostic.finalCapability,
      totalDurationMs: `${diagnostic.totalDurationMs}ms`,
      providers: Object.fromEntries(
        Object.entries(diagnostic.providers).map(([p, diag]) => [
          p,
          {
            durationMs: `${diag.durationMs}ms`,
            status: diag.status,
            records: diag.recordsReturned,
            usable: diag.usableLyricsPayloads,
            bestScore: diag.bestScore,
            rejection: diag.rejectionReason,
            error: diag.error,
          },
        ]),
      ),
    });
  }
}

export function getLatestLyricsDiagnostic(): LyricsSearchDiagnostic | null {
  return latestDiagnostic;
}

export function getLyricsDiagnosticHistory(): LyricsSearchDiagnostic[] {
  return [...diagnosticHistory];
}

export function clearLyricsDiagnostics(): void {
  latestDiagnostic = null;
  diagnosticHistory.length = 0;
}
