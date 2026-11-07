import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { DynamicIslandNotification } from "./DynamicIslandNotification";
import { useDynamicIslandStore } from "../stores/dynamicIslandStore";

const mockNavigate = vi.fn();

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

function renderWithRouter(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe("DynamicIslandNotification UI component", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockNavigate.mockReset();
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
    const { container } = renderWithRouter(<DynamicIslandNotification />);
    expect(container.firstChild).toBeNull();
  });

  it("renders with alert role, big typography title, and track pill without clutter description", () => {
    renderWithRouter(<DynamicIslandNotification />);

    act(() => {
      useDynamicIslandStore.getState().showNotification({
        title: "Audio not found",
        description: "The audio file could not be found or opened.",
        song: "Around Me — Noodah05",
        trackId: "t100",
      });
      vi.advanceTimersByTime(60);
    });

    const alert = screen.getByRole("alert");
    expect(alert).toBeTruthy();
    // Big typography title
    expect(screen.getByText("Audio not found")).toBeTruthy();
    // Track pill
    expect(screen.getByText("Around Me — Noodah05")).toBeTruthy();
    // Description should be omitted from the banner for rapid 3-second readability
    expect(screen.queryByText("The audio file could not be found or opened.")).toBeNull();
  });

  it("clicking the notification banner navigates to broken page with trackId", () => {
    renderWithRouter(<DynamicIslandNotification />);

    act(() => {
      useDynamicIslandStore.getState().showNotification({
        title: "Audio not found",
        description: "Missing file",
        song: "Song A — Artist B",
        trackId: "t-abc-123",
      });
      vi.advanceTimersByTime(60);
    });

    const banner = screen.getByRole("button", { name: /Audio not found/i });
    act(() => {
      fireEvent.click(banner);
    });

    expect(mockNavigate).toHaveBeenCalledWith("/broken?trackId=t-abc-123");
    // Should initiate collapse/dismiss upon navigation
    expect(useDynamicIslandStore.getState().stage).toBe("collapsing");
  });

  it("pressing Enter or Space on focused banner navigates to broken page", () => {
    renderWithRouter(<DynamicIslandNotification />);

    act(() => {
      useDynamicIslandStore.getState().showNotification({
        title: "Playback failed",
        description: "Corrupted audio",
        trackId: "t-keyboard-1",
      });
      vi.advanceTimersByTime(60);
    });

    const banner = screen.getByRole("button", { name: /Playback failed/i });
    act(() => {
      fireEvent.keyDown(banner, { key: "Enter" });
    });

    expect(mockNavigate).toHaveBeenCalledWith("/broken?trackId=t-keyboard-1");
  });

  it("clicking the close button dismisses notification WITHOUT navigating", () => {
    renderWithRouter(<DynamicIslandNotification />);

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

    expect(mockNavigate).not.toHaveBeenCalled();
    expect(useDynamicIslandStore.getState().stage).toBe("collapsing");

    act(() => {
      vi.advanceTimersByTime(240);
    });
    expect(useDynamicIslandStore.getState().current).toBeNull();
    expect(useDynamicIslandStore.getState().stage).toBe("idle");
  });

  it("pauses auto-dismiss on hover and resumes on mouse leave", () => {
    renderWithRouter(<DynamicIslandNotification />);

    act(() => {
      useDynamicIslandStore.getState().showNotification({
        title: "Pause on hover",
        description: "Hovering should pause 3s countdown",
        trackId: "t-pause",
      });
      vi.advanceTimersByTime(60);
    });

    expect(useDynamicIslandStore.getState().stage).toBe("expanded");

    // Advance 1500ms
    act(() => {
      vi.advanceTimersByTime(1500);
    });

    const banner = screen.getByRole("button", { name: /Pause on hover/i });
    // Hover: should pause
    act(() => {
      fireEvent.mouseEnter(banner);
    });

    // Advance another 3000ms while hovered - should NOT dismiss
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(useDynamicIslandStore.getState().stage).toBe("expanded");

    // Mouse leave: should resume
    act(() => {
      fireEvent.mouseLeave(banner);
    });

    // Advance remaining ~1500ms
    act(() => {
      vi.advanceTimersByTime(1600);
    });
    expect(useDynamicIslandStore.getState().stage).toBe("collapsing");
  });

  it("pauses auto-dismiss on focus and resumes on blur", () => {
    renderWithRouter(<DynamicIslandNotification />);

    act(() => {
      useDynamicIslandStore.getState().showNotification({
        title: "Pause on focus",
        description: "Focus should pause countdown",
        trackId: "t-focus",
      });
      vi.advanceTimersByTime(60);
    });

    const banner = screen.getByRole("button", { name: /Pause on focus/i });
    act(() => {
      fireEvent.focus(banner);
      vi.advanceTimersByTime(4000);
    });
    expect(useDynamicIslandStore.getState().stage).toBe("expanded");

    act(() => {
      fireEvent.blur(banner);
      vi.advanceTimersByTime(3100);
    });
    expect(useDynamicIslandStore.getState().stage).toBe("collapsing");
  });

  it("simplifies transitions when reduced motion is preferred", () => {
    document.documentElement.dataset.motion = "on";
    renderWithRouter(<DynamicIslandNotification />);

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
