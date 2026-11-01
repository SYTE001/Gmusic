import { useEffect, useRef } from "react";
import { useLyricsAmbient, type AmbientSource, type AmbientTheme } from "./useLyricsAmbient";
import "./ambientBackground.css";

/**
 * Dynamic liquid ambient background for the lyrics player (Now Playing).
 *
 * Layers, bottom to top:
 *   stack A / stack B — two isolated scene stacks, each holding a drifting
 *     base canvas plus a counter-drifting soft-light sheen canvas. Their
 *     relative motion creates the slow "flowing liquid" interference; both
 *     run pure CSS transform keyframes (GPU-composited, no per-frame work).
 *   scrim — theme-aware readability wash, never animated.
 *
 * Transitions are a two-stack crossfade: the next source is painted into the
 * hidden stack, which then fades in above the settled one, so artwork swaps,
 * artwork→fallback, fallback→artwork, and theme swaps never flash. The CSS
 * animations keep running through the swap, preserving the motion state; a
 * fast song change finalizes any in-flight fade first. Everything time-based
 * is imperative (canvas paints, style writes) — React re-renders only when
 * the track, theme, or motion preference actually changes, never per frame.
 */

const CROSSFADE_MS = 650;
const BASE_CANVAS_WIDTH = 384;
const SHEEN_CANVAS_WIDTH = 192;
/** Overscan so the live blur never bleeds a transparent edge into view. */
const ARTWORK_OVERSCAN = 1.18;

type StackRefs = {
  root: HTMLDivElement | null;
  base: HTMLCanvasElement | null;
  sheen: HTMLCanvasElement | null;
};

function sizeCanvas(canvas: HTMLCanvasElement, targetWidth: number): void {
  const viewW = typeof window !== "undefined" && window.innerWidth ? window.innerWidth : 1280;
  const viewH = typeof window !== "undefined" && window.innerHeight ? window.innerHeight : 720;
  canvas.width = targetWidth;
  canvas.height = Math.max(160, Math.round((targetWidth * viewH) / viewW));
}

function drawCover(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  width: number,
  height: number,
  overscan: number,
): void {
  const naturalWidth = image.naturalWidth || image.width;
  const naturalHeight = image.naturalHeight || image.height;
  if (!naturalWidth || !naturalHeight) return;
  const scale = Math.max(width / naturalWidth, height / naturalHeight) * overscan;
  const drawWidth = naturalWidth * scale;
  const drawHeight = naturalHeight * scale;
  ctx.drawImage(image, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
}

/** Theme-aware tone mapping: deep for dark mode, airy for light mode. */
function artworkFilter(theme: AmbientTheme, sheen: boolean): string {
  if (theme === "dark") {
    return sheen ? "blur(20px) brightness(1.05) saturate(1.06)" : "blur(26px) brightness(0.72) saturate(1.06)";
  }
  return sheen ? "blur(20px) brightness(1.12) saturate(1.03)" : "blur(26px) brightness(1.15) saturate(1.03)";
}

/**
 * Paints one scene stack for the given source. Returns false when the canvas
 * is unavailable (jsdom, detached node) so callers keep their previous frame
 * instead of half-updating.
 */
function paintStack(stack: StackRefs, source: AmbientSource | null, theme: AmbientTheme, paintSheen: boolean): boolean {
  const base = stack.base;
  const baseCtx = base?.getContext("2d");
  if (!base || !baseCtx) return false;
  sizeCanvas(base, BASE_CANVAS_WIDTH);
  baseCtx.filter = "none";

  if (!source) {
    baseCtx.fillStyle = theme === "dark" ? "#0a0b0d" : "#edeff2";
    baseCtx.fillRect(0, 0, base.width, base.height);
    return true;
  }

  if (source.kind === "artwork") {
    // Blur edges bleed transparent, so start from a theme-matched base fill.
    baseCtx.fillStyle = theme === "dark" ? "#0a0b0d" : "#edeff2";
    baseCtx.fillRect(0, 0, base.width, base.height);
    baseCtx.filter = artworkFilter(theme, false);
    drawCover(baseCtx, source.image, base.width, base.height, ARTWORK_OVERSCAN);
    baseCtx.filter = "none";
    baseCtx.fillStyle = theme === "dark" ? "rgba(4, 5, 7, 0.38)" : "rgba(250, 251, 252, 0.30)";
    baseCtx.fillRect(0, 0, base.width, base.height);
  } else {
    // Supplied fallbacks are already tuned; preserve them unfiltered.
    drawCover(baseCtx, source.image, base.width, base.height, 1);
  }

  const sheenCtx = stack.sheen?.getContext("2d");
  if (paintSheen && stack.sheen && sheenCtx) {
    sizeCanvas(stack.sheen, SHEEN_CANVAS_WIDTH);
    sheenCtx.clearRect(0, 0, stack.sheen.width, stack.sheen.height);
    sheenCtx.filter = source.kind === "artwork" ? artworkFilter(theme, true) : "blur(4px)";
    drawCover(sheenCtx, source.image, stack.sheen.width, stack.sheen.height, ARTWORK_OVERSCAN + 0.1);
    sheenCtx.filter = "none";
  }
  return true;
}

/** Stack roles. z-order: hidden(1) < settled(2) < fading(3, above everything). */
function setInstant(el: HTMLElement, opacity: string, zIndex: string): void {
  el.style.transition = "none";
  el.style.opacity = opacity;
  el.style.zIndex = zIndex;
  void el.offsetWidth; // commit before the CSS transition is restored
  el.style.transition = "";
}

function setAnimated(el: HTMLElement, opacity: string, zIndex: string): void {
  el.style.transition = "";
  el.style.zIndex = zIndex;
  el.style.opacity = opacity;
}

/** Only the on-screen stack runs its liquid animations; hidden ones freeze. */
function setPaused(el: HTMLElement, paused: boolean): void {
  el.dataset.paused = paused ? "true" : "false";
}

export default function LyricsAmbientBackground({ trackId }: { trackId: string | undefined }) {
  const { artworkImage, fallbackImage, theme, reducedMotion } = useLyricsAmbient(trackId);

  const rootRef = useRef<HTMLDivElement>(null);
  const stackARef = useRef<HTMLDivElement>(null);
  const stackBRef = useRef<HTMLDivElement>(null);
  const baseARef = useRef<HTMLCanvasElement>(null);
  const sheenARef = useRef<HTMLCanvasElement>(null);
  const baseBRef = useRef<HTMLCanvasElement>(null);
  const sheenBRef = useRef<HTMLCanvasElement>(null);
  const settledIndexRef = useRef<0 | 1>(0);
  const fadeTimerRef = useRef<number | null>(null);
  const lastKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    const stacks: StackRefs[] = [
      { root: stackARef.current, base: baseARef.current, sheen: sheenARef.current },
      { root: stackBRef.current, base: baseBRef.current, sheen: sheenBRef.current },
    ];
    if (!root || !stacks[0].root || !stacks[1].root) return;

    const source: AmbientSource | null = artworkImage
      ? { kind: "artwork", image: artworkImage }
      : fallbackImage
        ? { kind: "fallback", image: fallbackImage }
        : null;
    // The key folds in theme (artwork is re-toned per theme) and the motion
    // preference (the sheen canvas is remounted when it flips).
    const sourceKey = `${source ? (source.kind === "artwork" ? `art:${source.image.src}` : "fb") : "empty"}:${theme}:${reducedMotion ? "r" : "m"}`;

    const settle = (fadingIndex: 0 | 1) => {
      const settledEl = stacks[settledIndexRef.current].root;
      const fadingEl = stacks[fadingIndex].root;
      if (settledEl) {
        setInstant(settledEl, "0", "1");
        setPaused(settledEl, true);
      }
      if (fadingEl) {
        setInstant(fadingEl, "1", "2");
        setPaused(fadingEl, false);
      }
      settledIndexRef.current = fadingIndex;
    };

    const finalizeInFlight = () => {
      if (fadeTimerRef.current === null) return;
      window.clearTimeout(fadeTimerRef.current);
      fadeTimerRef.current = null;
      // Jump the running crossfade to its end state, then proceed as idle.
      const fadingIndex = (1 - settledIndexRef.current) as 0 | 1;
      setInstant(stacks[fadingIndex].root!, "1", "3");
      settle(fadingIndex);
    };

    if (sourceKey === lastKeyRef.current) return;
    const firstPaint = lastKeyRef.current === null;
    lastKeyRef.current = sourceKey;
    root.dataset.source = source?.kind ?? "empty";
    root.dataset.reduced = reducedMotion ? "true" : "false";

    if (firstPaint) {
      paintStack(stacks[settledIndexRef.current], source, theme, !reducedMotion);
      setInstant(stacks[settledIndexRef.current].root!, "1", "2");
      setPaused(stacks[settledIndexRef.current].root!, false);
      setPaused(stacks[1 - settledIndexRef.current].root!, true);
      root.classList.add("is-ready");
      return;
    }

    finalizeInFlight();
    const hiddenIndex = (1 - settledIndexRef.current) as 0 | 1;
    if (!paintStack(stacks[hiddenIndex], source, theme, !reducedMotion)) return;

    if (reducedMotion) {
      settle(hiddenIndex);
    } else {
      setAnimated(stacks[hiddenIndex].root!, "1", "3");
      setPaused(stacks[hiddenIndex].root!, false);
      fadeTimerRef.current = window.setTimeout(() => {
        fadeTimerRef.current = null;
        settle((1 - settledIndexRef.current) as 0 | 1);
      }, CROSSFADE_MS);
    }
  }, [artworkImage, fallbackImage, theme, reducedMotion]);

  useEffect(() => {
    return () => {
      if (fadeTimerRef.current !== null) window.clearTimeout(fadeTimerRef.current);
    };
  }, []);

  return (
    <div ref={rootRef} className="gm-ambient" aria-hidden="true">
      <div ref={stackARef} className="gm-ambient__stack">
        <canvas ref={baseARef} className="gm-ambient__layer gm-ambient__layer--base" />
        {!reducedMotion && <canvas ref={sheenARef} className="gm-ambient__layer gm-ambient__layer--sheen" />}
      </div>
      <div ref={stackBRef} className="gm-ambient__stack">
        <canvas ref={baseBRef} className="gm-ambient__layer gm-ambient__layer--base" />
        {!reducedMotion && <canvas ref={sheenBRef} className="gm-ambient__layer gm-ambient__layer--sheen" />}
      </div>
      <div className="gm-ambient__scrim" />
    </div>
  );
}
