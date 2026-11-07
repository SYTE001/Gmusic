/**
 * Lightweight dev-only performance instrumentation for track-change profiling.
 * Active only when `import.meta.env.DEV` is true and `__GMUSIC_PERF__` is enabled.
 */

declare global {
  interface Window {
    __GMUSIC_PERF__?: boolean;
  }
}

let perfEnabledOverride = false;

export function setPerfEnabled(enabled: boolean): void {
  perfEnabledOverride = enabled;
  if (typeof window !== "undefined") {
    window.__GMUSIC_PERF__ = enabled;
  }
}

export function isPerfEnabled(): boolean {
  if (!import.meta.env.DEV) return false;
  if (perfEnabledOverride) return true;
  if (typeof window !== "undefined" && window.__GMUSIC_PERF__ === true) return true;
  return false;
}

const renderCounts = new Map<string, number>();
let activeUrlCount = 0;
let totalUrlsCreated = 0;
let totalUrlsRevoked = 0;

export function perfMark(name: string): void {
  if (!isPerfEnabled() || typeof performance === "undefined") return;
  try {
    performance.mark(name);
  } catch {
    // Ignore unsupported mark environments
  }
}

export function perfMeasure(name: string, startMark: string, endMark?: string): number {
  if (!isPerfEnabled() || typeof performance === "undefined") return 0;
  try {
    if (endMark) {
      performance.mark(endMark);
      const entry = performance.measure(name, startMark, endMark);
      return entry?.duration ?? 0;
    }
    const entry = performance.measure(name, startMark);
    return entry?.duration ?? 0;
  } catch {
    return 0;
  }
}

export function recordComponentRender(componentName: string): void {
  if (!isPerfEnabled()) return;
  renderCounts.set(componentName, (renderCounts.get(componentName) ?? 0) + 1);
}

export function recordObjectUrlCreated(): void {
  activeUrlCount += 1;
  totalUrlsCreated += 1;
}

export function recordObjectUrlRevoked(): void {
  activeUrlCount = Math.max(0, activeUrlCount - 1);
  totalUrlsRevoked += 1;
}

export function getObjectUrlStats(): { active: number; created: number; revoked: number } {
  return { active: activeUrlCount, created: totalUrlsCreated, revoked: totalUrlsRevoked };
}

export function resetObjectUrlStats(): void {
  activeUrlCount = 0;
  totalUrlsCreated = 0;
  totalUrlsRevoked = 0;
}

export function getRenderCounts(): Record<string, number> {
  return Object.fromEntries(renderCounts.entries());
}

export function resetPerfMetrics(): void {
  renderCounts.clear();
  if (typeof performance !== "undefined") {
    try {
      performance.clearMarks();
      performance.clearMeasures();
    } catch {
      // Ignore
    }
  }
}
