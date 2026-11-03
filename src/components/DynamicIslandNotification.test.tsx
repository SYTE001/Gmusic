import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DynamicIslandNotification } from "./DynamicIslandNotification";
import { useDynamicIslandStore } from "../stores/dynamicIslandStore";

describe("DynamicIslandNotification UI component", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useDynamicIslandStore.getState().reset();
    delete document.documentElement.dataset.motion;
  });

  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
    useDynamicIslandStore.getState().reset();
    delete document.documentElement.dataset.motion;
  });

  it("does not render when stage is idle or current is null", () => {
    const { container } = render(<DynamicIslandNotification />);
    expect(container.firstChild).toBeNull();
  });

  it("renders with alert role, title, description, and song", () => {
    render(<DynamicIslandNotification />);

    act(() => {
      useDynamicIslandStore.getState().showNotification({
        title: "Playback failed",
        description: "This audio file appears to be corrupted.",
        song: "Around Me — Noodah05",
        trackId: "t100",
      });
      vi.advanceTimersByTime(60);
    });

    const alert = screen.getByRole("alert");
    expect(alert).toBeTruthy();
    expect(screen.getByText("Playback failed")).toBeTruthy();
    expect(screen.getByText("This audio file appears to be corrupted.")).toBeTruthy();
    expect(screen.getByText("Around Me — Noodah05")).toBeTruthy();
  });

  it("dismisses on clicking the close button", () => {
    render(<DynamicIslandNotification />);

    act(() => {
      useDynamicIslandStore.getState().showNotification({
        title: "Dismiss Me",
        description: "Tap X to close",
        trackId: "t200",
      });
      vi.advanceTimersByTime(60);
    });

    const closeBtn = screen.getByRole("button", { name: "Dismiss notification" });
    act(() => {
      fireEvent.click(closeBtn);
    });

    expect(useDynamicIslandStore.getState().stage).toBe("collapsing");

    act(() => {
      vi.advanceTimersByTime(240);
    });
    expect(useDynamicIslandStore.getState().current).toBeNull();
    expect(useDynamicIslandStore.getState().stage).toBe("idle");
  });

  it("simplifies transitions when reduced motion is preferred", () => {
    document.documentElement.dataset.motion = "on";
    render(<DynamicIslandNotification />);

    act(() => {
      useDynamicIslandStore.getState().showNotification({
        title: "Reduced Motion Error",
        description: "Instant appearance",
        trackId: "t300",
      });
      vi.advanceTimersByTime(60);
    });

    const alert = screen.getByRole("alert");
    expect(alert).toBeTruthy();
    expect(screen.getByText("Reduced Motion Error")).toBeTruthy();
  });
});
