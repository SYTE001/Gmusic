import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INTRO_EXIT_DURATION_MS,
  INTRO_EXIT_START_MS,
  INTRO_REDUCED_MOTION_EXIT_MS,
  INTRO_REDUCED_MOTION_HOLD_MS,
  INTRO_SPLASH_STORAGE_KEY,
  IntroSplash,
} from "./IntroSplash";

function mockMatchMedia(reduceMotion: boolean) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)" ? reduceMotion : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

describe("IntroSplash", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.sessionStorage.clear();
    delete document.documentElement.dataset.motion;
    mockMatchMedia(false);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    window.sessionStorage.clear();
    delete document.documentElement.dataset.motion;
  });

  it("renders native SVG mark, staggered brand title, and Skip button during active choreography", () => {
    render(<IntroSplash />);

    const splash = screen.getByTestId("intro-splash");
    expect(splash).toBeTruthy();
    expect(splash.getAttribute("data-phase")).toBe("active");
    expect(splash.style.pointerEvents).toBe("auto");

    expect(screen.getByRole("heading", { name: "Gmusic" })).toBeTruthy();
    expect(screen.getByText("Personal Audio Studio")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Skip intro" })).toBeTruthy();
    expect(splash.querySelector("svg.intro-splash__svg")).not.toBeNull();
  });

  it("follows the 2.1s -> 2.7s exit transition timeline and disables pointer-events on exit start", () => {
    const onExitStart = vi.fn();
    const onComplete = vi.fn();

    render(<IntroSplash onExitStart={onExitStart} onComplete={onComplete} />);
    const splash = screen.getByTestId("intro-splash");

    // Still active during Stage Entrance (0.4s), Hero Motion (1.6s), and Hold & Settle (< 2.1s)
    act(() => {
      vi.advanceTimersByTime(INTRO_EXIT_START_MS - 10);
    });
    expect(splash.getAttribute("data-phase")).toBe("active");
    expect(onExitStart).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();

    // At 2.1s (2100ms), enters Smooth Exit Transition and sets pointer-events: none immediately
    act(() => {
      vi.advanceTimersByTime(10);
    });
    expect(onExitStart).toHaveBeenCalledTimes(1);
    expect(splash.getAttribute("data-phase")).toBe("exiting");
    expect(splash.classList.contains("intro-splash--exiting")).toBe(true);
    expect(splash.style.pointerEvents).toBe("none");
    expect(onComplete).not.toHaveBeenCalled();

    // Completes 600ms exit transition at 2.7s (2700ms) and unmounts
    act(() => {
      vi.advanceTimersByTime(INTRO_EXIT_DURATION_MS);
    });
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("intro-splash")).toBeNull();
  });

  it("immediately enters the smooth exit phase when the Skip button is clicked", () => {
    const onExitStart = vi.fn();
    const onComplete = vi.fn();

    render(<IntroSplash onExitStart={onExitStart} onComplete={onComplete} />);
    const skipBtn = screen.getByRole("button", { name: "Skip intro" });

    fireEvent.click(skipBtn);

    const splash = screen.getByTestId("intro-splash");
    expect(onExitStart).toHaveBeenCalledTimes(1);
    expect(splash.getAttribute("data-phase")).toBe("exiting");
    expect(splash.classList.contains("intro-splash--exiting")).toBe(true);
    expect(splash.style.pointerEvents).toBe("none");

    act(() => {
      vi.advanceTimersByTime(INTRO_EXIT_DURATION_MS);
    });
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("intro-splash")).toBeNull();
  });

  it("plays only once per session unless forceShow is enabled", () => {
    const firstComplete = vi.fn();
    const { unmount } = render(<IntroSplash onComplete={firstComplete} />);

    expect(window.sessionStorage.getItem(INTRO_SPLASH_STORAGE_KEY)).toBe("1");
    expect(screen.getByTestId("intro-splash")).toBeTruthy();
    unmount();

    // Subsequent mount in same session skips immediately
    const secondComplete = vi.fn();
    render(<IntroSplash onComplete={secondComplete} />);
    expect(screen.queryByTestId("intro-splash")).toBeNull();
    expect(secondComplete).toHaveBeenCalledTimes(1);

    // forceShow overrides sessionStorage
    render(<IntroSplash forceShow />);
    expect(screen.getByTestId("intro-splash")).toBeTruthy();
  });

  it("accelerates transition timings when prefers-reduced-motion: reduce is active", () => {
    mockMatchMedia(true);
    const onComplete = vi.fn();

    render(<IntroSplash onComplete={onComplete} />);
    const splash = screen.getByTestId("intro-splash");

    act(() => {
      vi.advanceTimersByTime(INTRO_REDUCED_MOTION_HOLD_MS);
    });
    expect(splash.getAttribute("data-phase")).toBe("exiting");

    act(() => {
      vi.advanceTimersByTime(INTRO_REDUCED_MOTION_EXIT_MS);
    });
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("intro-splash")).toBeNull();
  });
});
