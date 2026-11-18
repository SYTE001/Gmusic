import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { DynamicIslandNotification } from "./DynamicIslandNotification";
import { AppShell } from "./AppShell";
import { useDynamicIslandStore } from "../stores/dynamicIslandStore";
import { useLibraryStore } from "../stores/libraryStore";
import { usePlaybackStore } from "../stores/playbackStore";
import { DEFAULT_PREFERENCES, useSettingsStore } from "../stores/settingsStore";
import { clearArtworkCache, setCachedArtworkForTrack } from "../services/artwork/artworkCache";
import type { AudioEngine } from "../services/audio/engine";
import type { Track } from "../types";

// No real artwork can load for synthetic test tracks. Stub the async loader
// (keeping the real cache functions) so a late loadArtworkUrl resolution from
// an earlier mount can never notify and wipe a URL a test cached on purpose.
vi.mock("../services/artwork/artworkCache", async () => {
  const actual = await vi.importActual<typeof import("../services/artwork/artworkCache")>(
    "../services/artwork/artworkCache",
  );
  return {
    ...actual,
    loadArtworkUrl: vi.fn(() => Promise.resolve(undefined)),
  };
});

/** Dispatch a pointer event; jsdom lacks a PointerEvent constructor, so fall back to MouseEvent with pointer props defined. */
function firePointer(
  el: Element,
  type: string,
  opts: { clientX?: number; clientY?: number; pointerId?: number; isPrimary?: boolean } = {},
) {
  act(() => {
    const Ctor =
      (window as unknown as { PointerEvent?: typeof MouseEvent }).PointerEvent ?? MouseEvent;
    const event = new Ctor(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "pointerId", { value: opts.pointerId ?? 1 });
    Object.defineProperty(event, "isPrimary", { value: opts.isPrimary ?? true });
    Object.defineProperty(event, "clientX", { value: opts.clientX ?? 0 });
    Object.defineProperty(event, "clientY", { value: opts.clientY ?? 0 });
    el.dispatchEvent(event);
  });
}

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

function createTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: "track-media-1",
    title: "Midnight City",
    artist: "M83",
    album: "Hurry Up, We're Dreaming",
    trackNumber: 1,
    albumTrackCount: 12,
    durationMs: 240000,
    fileName: "midnight_city.mp3",
    fileSize: 4096000,
    mimeType: "audio/mpeg",
    addedAt: 1672531200000,
    lastPlayedAt: null,
    playCount: 5,
    isLiked: false,
    availability: "available",
    accessMode: "stored-copy",
    fingerprint: "fp-media",
    metadataFromFilename: false,
    ...overrides,
  };
}

/** Deterministic engine stub — jsdom has no real audio and rAF reads must not throw. */
function stubEngine() {
  usePlaybackStore.setState({
    getEngine: (() => ({ element: null, currentTimeSec: 0 })) as unknown as () => AudioEngine,
  });
}

describe("DynamicIslandNotification media card", () => {
  let togglePlaySpy: ReturnType<typeof vi.fn>;
  let nextSpy: ReturnType<typeof vi.fn>;
  let previousSpy: ReturnType<typeof vi.fn>;
  let seekSpy: ReturnType<typeof vi.fn>;
  let seekBySpy: ReturnType<typeof vi.fn>;
  let toggleLikeSpy: ReturnType<typeof vi.fn>;

  function setupStores(trackOverrides: Partial<Track> = {}) {
    togglePlaySpy = vi.fn();
    nextSpy = vi.fn();
    previousSpy = vi.fn();
    seekSpy = vi.fn();
    seekBySpy = vi.fn();
    toggleLikeSpy = vi.fn();
    usePlaybackStore.setState({
      currentTrackId: "track-media-1",
      currentTimeMs: 60000,
      durationMs: 240000,
      isPlaying: false,
      togglePlay: togglePlaySpy,
      next: nextSpy,
      previous: previousSpy,
      seek: seekSpy,
      seekBy: seekBySpy,
    });
    stubEngine();
    useLibraryStore.setState({
      tracks: [createTrack(trackOverrides)],
      toggleLike: toggleLikeSpy,
    });
  }

  function showMedia() {
    act(() => {
      useDynamicIslandStore.getState().showMediaNotification("track-media-1");
      vi.advanceTimersByTime(60);
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    useDynamicIslandStore.getState().reset();
    clearArtworkCache();
    setupStores();
    delete document.documentElement.dataset.motion;
  });

  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
    useDynamicIslandStore.getState().reset();
    clearArtworkCache();
    delete document.documentElement.dataset.motion;
  });

  it("renders the frosted media card with track info, artwork and five controls", () => {
    renderWithRouter(<DynamicIslandNotification />);
    showMedia();

    const card = screen.getByRole("group", { name: "Now playing: Midnight City" });
    expect(card).toBeTruthy();
    expect(card.parentElement?.className).toContain("hidden md:flex");
    expect(card.getAttribute("data-kind")).toBe("media");
    expect(screen.getByText("Midnight City")).toBeTruthy();
    expect(screen.getByText("M83")).toBeTruthy();
    // 56px artwork container is the first child of the identity row
    const artwork = card.querySelector(".size-14");
    expect(artwork).toBeTruthy();
    // like / prev / play / next / queue
    expect(screen.getByRole("button", { name: "Add to liked songs" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Previous track" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next track" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open queue" })).toBeTruthy();
    // 5-bar equalizer present
    expect(card.querySelectorAll(".dimc-eq-bar")).toHaveLength(5);
  });

  it("wires play/pause, prev and next to the shared playback store", () => {
    renderWithRouter(<DynamicIslandNotification />);
    showMedia();

    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(togglePlaySpy).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Previous track" }));
    expect(previousSpy).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Next track" }));
    expect(nextSpy).toHaveBeenCalledWith(true);
  });

  it("shows Pause while playing and still routes through the playback store", () => {
    usePlaybackStore.setState({ isPlaying: true });
    renderWithRouter(<DynamicIslandNotification />);
    showMedia();

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(togglePlaySpy).toHaveBeenCalledTimes(1);
  });

  it("toggles like through the library store and reflects pressed state", () => {
    renderWithRouter(<DynamicIslandNotification />);
    showMedia();

    const likeButton = screen.getByRole("button", { name: "Add to liked songs" });
    expect(likeButton.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(likeButton);
    expect(toggleLikeSpy).toHaveBeenCalledWith("track-media-1");

    // Liked track renders pressed state with the matching label
    cleanup();
    useDynamicIslandStore.getState().reset();
    setupStores({ isLiked: true });
    renderWithRouter(<DynamicIslandNotification />);
    showMedia();
    const likedButton = screen.getByRole("button", { name: "Remove from liked songs" });
    expect(likedButton.getAttribute("aria-pressed")).toBe("true");
  });

  it("invokes the onOpenQueue callback from the queue control", () => {
    const onOpenQueue = vi.fn();
    renderWithRouter(<DynamicIslandNotification onOpenQueue={onOpenQueue} />);
    showMedia();

    fireEvent.click(screen.getByRole("button", { name: "Open queue" }));
    expect(onOpenQueue).toHaveBeenCalledTimes(1);
  });

  it("scrubs via pointer and seeks the shared engine on release", () => {
    renderWithRouter(<DynamicIslandNotification />);
    showMedia();

    const slider = screen.getByRole("slider", { name: "Seek" });
    vi.spyOn(slider, "getBoundingClientRect").mockReturnValue({
      left: 0,
      width: 100,
      height: 14,
      top: 0,
      right: 100,
      bottom: 14,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    // Pointer down at 50% of a 240000ms track = 120000ms
    firePointer(slider, "pointerdown", { clientX: 50, pointerId: 1, isPrimary: true });
    firePointer(slider, "pointerup", { clientX: 50, pointerId: 1, isPrimary: true });

    expect(seekSpy).toHaveBeenCalledWith(120000);
  });

  it("scrubs via keyboard arrows and seeks in 5s steps", () => {
    renderWithRouter(<DynamicIslandNotification />);
    showMedia();

    const slider = screen.getByRole("slider", { name: "Seek" });
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(seekBySpy).toHaveBeenLastCalledWith(5000);
    fireEvent.keyDown(slider, { key: "ArrowLeft" });
    expect(seekBySpy).toHaveBeenLastCalledWith(-5000);
  });

  it("dismisses with Escape", () => {
    renderWithRouter(<DynamicIslandNotification />);
    showMedia();

    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(useDynamicIslandStore.getState().stage).toBe("collapsing");
  });

  it("dismisses with Escape but respects editable targets", () => {
    renderWithRouter(<DynamicIslandNotification />);
    showMedia();

    const input = document.createElement("input");
    document.body.appendChild(input);
    act(() => {
      fireEvent.keyDown(input, { key: "Escape" });
    });
    input.remove();
    expect(useDynamicIslandStore.getState().stage).toBe("expanded");
  });

  it("pauses auto-dismiss on hover and resumes on leave", () => {
    renderWithRouter(<DynamicIslandNotification />);
    showMedia();

    const card = screen.getByRole("group", { name: /Now playing/ });
    act(() => {
      vi.advanceTimersByTime(1500);
      fireEvent.mouseEnter(card);
      vi.advanceTimersByTime(3000);
    });
    expect(useDynamicIslandStore.getState().stage).toBe("expanded");

    act(() => {
      fireEvent.mouseLeave(card);
      vi.advanceTimersByTime(1600);
    });
    expect(useDynamicIslandStore.getState().stage).toBe("collapsing");
  });

  it("keeps the card open while scrubbing, then resumes the countdown", () => {
    renderWithRouter(<DynamicIslandNotification />);
    showMedia();

    const slider = screen.getByRole("slider", { name: "Seek" });
    vi.spyOn(slider, "getBoundingClientRect").mockReturnValue({
      left: 0,
      width: 100,
      height: 14,
      top: 0,
      right: 100,
      bottom: 14,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    act(() => {
      firePointer(slider, "pointerdown", { clientX: 25, pointerId: 1, isPrimary: true });
      vi.advanceTimersByTime(3000);
    });
    // Scrubbing pauses dismissal
    expect(useDynamicIslandStore.getState().stage).toBe("expanded");

    act(() => {
      firePointer(slider, "pointerup", { clientX: 75, pointerId: 1, isPrimary: true });
      vi.advanceTimersByTime(3100);
    });
    expect(seekSpy).toHaveBeenCalledWith(180000);
    expect(useDynamicIslandStore.getState().stage).toBe("collapsing");
  });

  it("dismisses on swipe-up and snaps back otherwise", () => {
    renderWithRouter(<DynamicIslandNotification />);
    showMedia();

    const card = screen.getByRole("group", { name: /Now playing/ });
    // Small vertical drag: snaps back, stays open
    act(() => {
      firePointer(card, "pointerdown", { clientX: 100, clientY: 200, pointerId: 1, isPrimary: true });
      firePointer(card, "pointermove", { clientX: 100, clientY: 180, pointerId: 1, isPrimary: true });
      firePointer(card, "pointerup", { clientX: 100, clientY: 180, pointerId: 1, isPrimary: true });
    });
    expect(useDynamicIslandStore.getState().stage).toBe("expanded");

    // Large vertical drag: swipe-up dismisses
    act(() => {
      firePointer(card, "pointerdown", { clientX: 100, clientY: 200, pointerId: 2, isPrimary: true });
      firePointer(card, "pointermove", { clientX: 100, clientY: 150, pointerId: 2, isPrimary: true });
      firePointer(card, "pointerup", { clientX: 100, clientY: 150, pointerId: 2, isPrimary: true });
    });
    expect(useDynamicIslandStore.getState().stage).toBe("collapsing");
  });

  it("does not start a swipe from horizontal movement", () => {
    renderWithRouter(<DynamicIslandNotification />);
    showMedia();

    const card = screen.getByRole("group", { name: /Now playing/ });
    act(() => {
      firePointer(card, "pointerdown", { clientX: 100, clientY: 200, pointerId: 1, isPrimary: true });
      firePointer(card, "pointermove", { clientX: 160, clientY: 196, pointerId: 1, isPrimary: true });
      firePointer(card, "pointerup", { clientX: 160, clientY: 196, pointerId: 1, isPrimary: true });
    });
    expect(useDynamicIslandStore.getState().stage).toBe("expanded");
  });

  it("pointer cancel snaps the card back instead of dismissing a swipe", () => {
    renderWithRouter(<DynamicIslandNotification />);
    showMedia();

    const card = screen.getByRole("group", { name: /Now playing/ }) as HTMLElement;
    act(() => {
      firePointer(card, "pointerdown", { clientX: 100, clientY: 200, pointerId: 1, isPrimary: true });
      firePointer(card, "pointermove", { clientX: 100, clientY: 120, pointerId: 1, isPrimary: true });
      firePointer(card, "pointercancel", { pointerId: 1, isPrimary: true });
    });
    expect(useDynamicIslandStore.getState().stage).toBe("expanded");
    expect(card.style.transform).toBe("");
  });

  it("shows elapsed and negative remaining labels updated from store time without render-level state", () => {
    renderWithRouter(<DynamicIslandNotification />);
    showMedia();

    const elapsed = document.querySelector(".dimc-time-elapsed") as HTMLSpanElement;
    const remaining = document.querySelector(".dimc-time-remaining") as HTMLSpanElement;
    expect(elapsed.textContent).toBe("1:00");
    expect(remaining.textContent).toBe("-3:00");

    act(() => {
      usePlaybackStore.setState({ currentTimeMs: 90000 });
    });
    expect(elapsed.textContent).toBe("1:30");
    expect(remaining.textContent).toBe("-2:30");
  });

  it("renders a dark blurred ambient artwork layer from the cached artwork URL", () => {
    setCachedArtworkForTrack("track-media-1", "blob:ambient-test");
    renderWithRouter(<DynamicIslandNotification />);
    showMedia();

    const ambient = document.querySelector(".dimc-ambient") as HTMLDivElement;
    expect(ambient).toBeTruthy();
    expect(ambient.style.backgroundImage).toContain("blob:ambient-test");
    // Content is a positioned stacking layer rendered after (above) the ambient backdrop;
    // the actual z-index comes from DynamicIslandMediaCard.css (.dimc-content { z-index: 1 }).
    const content = document.querySelector(".dimc-content") as HTMLElement;
    expect(ambient.nextElementSibling).toBe(content);

    clearArtworkCache();
  });

  it("has no ambient layer when no artwork URL is available", () => {
    renderWithRouter(<DynamicIslandNotification />);
    showMedia();

    expect(document.querySelector(".dimc-ambient")).toBeNull();
    expect(screen.getByRole("group", { name: /Now playing/ })).toBeTruthy();
  });

  it("closes via the manual close button without navigating", () => {
    renderWithRouter(<DynamicIslandNotification />);
    showMedia();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));

    expect(mockNavigate).not.toHaveBeenCalled();
    expect(useDynamicIslandStore.getState().stage).toBe("collapsing");
  });

  it("keeps the countdown paused while focus moves between controls inside the card", () => {
    renderWithRouter(<DynamicIslandNotification />);
    showMedia();

    const like = screen.getByRole("button", { name: "Add to liked songs" });
    const play = screen.getByRole("button", { name: "Play" });

    act(() => {
      fireEvent.focus(like);
      vi.advanceTimersByTime(1000);
      // Blur toward another control inside the card must NOT resume dismissal
      fireEvent.blur(like, { relatedTarget: play });
      vi.advanceTimersByTime(4000);
    });
    expect(useDynamicIslandStore.getState().stage).toBe("expanded");

    act(() => {
      // Blur leaving the card entirely resumes the countdown
      fireEvent.blur(like, { relatedTarget: null });
      vi.advanceTimersByTime(3100);
    });
    expect(useDynamicIslandStore.getState().stage).toBe("collapsing");
  });

  it("pauses dismissal for hover that begins before the card finishes expanding", () => {
    renderWithRouter(<DynamicIslandNotification />);
    act(() => {
      useDynamicIslandStore.getState().showMediaNotification("track-media-1");
      // Stage is still "initial"; the store cannot pause yet.
    });
    const card = screen.getByRole("group", { name: /Now playing/ });

    act(() => {
      fireEvent.mouseEnter(card);
      vi.advanceTimersByTime(60); // card expands now
    });
    expect(useDynamicIslandStore.getState().stage).toBe("expanded");

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    // Hover carried through the stage transition: still open
    expect(useDynamicIslandStore.getState().stage).toBe("expanded");

    act(() => {
      fireEvent.mouseLeave(card);
      vi.advanceTimersByTime(3100);
    });
    expect(useDynamicIslandStore.getState().stage).toBe("collapsing");
  });

  it("does not double-fire Space on a media control through the AppShell global shortcut", () => {
    Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: 1280 });
    useSettingsStore.setState({ prefs: { ...DEFAULT_PREFERENCES, miniPlayerMode: "auto" }, loaded: true });
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<div>Home View</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    showMedia();

    const card = document.querySelector('[data-kind="media"]') as HTMLElement;
    expect(card).toBeTruthy();
    const play = within(card).getByRole("button", { name: "Play" });

    // Space on the focused play button: the card's control stops propagation,
    // so AppShell's global Space shortcut must not fire a second toggle.
    act(() => {
      play.focus();
      fireEvent.keyDown(play, { key: " " });
    });
    expect(togglePlaySpy).not.toHaveBeenCalled();

    fireEvent.click(play);
    expect(togglePlaySpy).toHaveBeenCalledTimes(1);
  });
});
