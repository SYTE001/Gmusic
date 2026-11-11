import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { IntroSplash } from "./IntroSplash";

describe("IntroSplash", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    delete document.documentElement.dataset.motion;
  });

  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
    delete document.documentElement.dataset.motion;
  });

  it("renders the official mark geometry on a black decorative overlay", () => {
    const { container } = render(<IntroSplash />);
    const splash = container.firstElementChild as HTMLElement;

    expect(splash.getAttribute("aria-hidden")).toBe("true");
    expect(splash.getAttribute("role")).toBe("presentation");
    expect(splash.getAttribute("data-phase")).toBe("play");

    // The svg frames the official mark bounds and reuses its exact shapes.
    const svg = splash.querySelector("svg");
    expect(svg?.getAttribute("viewBox")).toBe("196 112 206 258");
    expect(svg?.querySelectorAll("path")).toHaveLength(1);
    expect(svg?.querySelector("path")?.getAttribute("d")).toBe("M322 118l-118 26v40l118-26z");
    expect(svg?.querySelectorAll("rect")).toHaveLength(1);
    expect(svg?.querySelectorAll("circle")).toHaveLength(2);

    // No text in the intro composition.
    expect(splash.textContent?.trim()).toBe("");
  });

  it("unmounts itself after the hold (3.75s) and handoff fade (250ms)", () => {
    const { container } = render(<IntroSplash />);

    act(() => {
      vi.advanceTimersByTime(3749);
    });
    expect(container.firstElementChild?.getAttribute("data-phase")).toBe("play");

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(container.firstElementChild?.getAttribute("data-phase")).toBe("exit");

    act(() => {
      vi.advanceTimersByTime(249);
    });
    expect(container.firstElementChild).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(container.firstElementChild).toBeNull();
  });

  it("skips ahead to the handoff on pointer press", () => {
    const { container } = render(<IntroSplash />);
    const splash = container.firstElementChild as HTMLElement;

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    fireEvent.pointerDown(splash);

    expect(splash.getAttribute("data-phase")).toBe("exit");
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(container.firstElementChild).toBeNull();
  });

  it("skips ahead to the handoff on Escape", () => {
    const { container } = render(<IntroSplash />);

    fireEvent.keyDown(window, { key: "Escape" });

    expect(container.firstElementChild?.getAttribute("data-phase")).toBe("exit");
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(container.firstElementChild).toBeNull();
  });

  it("never renders when reduced motion is requested", () => {
    document.documentElement.dataset.motion = "on";
    const { container } = render(<IntroSplash />);
    expect(container.firstElementChild).toBeNull();

    // The skipped intro must not leave timers behind.
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(container.firstElementChild).toBeNull();
  });
});
