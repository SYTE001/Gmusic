import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDynamicIslandStore } from "./dynamicIslandStore";

describe("dynamic island media lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useDynamicIslandStore.getState().reset();
  });

  afterEach(() => {
    useDynamicIslandStore.getState().reset();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("shows a media item with the requested track id", () => {
    useDynamicIslandStore.getState().showMediaNotification("track-a");

    expect(useDynamicIslandStore.getState().current).toMatchObject({
      kind: "media",
      trackId: "track-a",
    });
    expect(useDynamicIslandStore.getState().stage).toBe("initial");
  });

  it("replaces an active media item instead of queueing stale songs", () => {
    useDynamicIslandStore.getState().showMediaNotification("track-a");
    vi.advanceTimersByTime(60);

    useDynamicIslandStore.getState().showMediaNotification("track-b");

    expect(useDynamicIslandStore.getState().current?.trackId).toBe("track-b");
    expect(useDynamicIslandStore.getState().queue).toHaveLength(0);
  });

  it("keeps an active error in front of the latest media item", () => {
    useDynamicIslandStore.getState().showNotification({
      title: "Playback failed",
      description: "Missing audio",
      trackId: "track-error",
    });
    vi.advanceTimersByTime(60);

    useDynamicIslandStore.getState().showMediaNotification("track-a");
    useDynamicIslandStore.getState().showMediaNotification("track-b");

    expect(useDynamicIslandStore.getState().current?.kind).toBeUndefined();
    expect(useDynamicIslandStore.getState().current?.trackId).toBe("track-error");
    expect(useDynamicIslandStore.getState().queue).toHaveLength(1);
    expect(useDynamicIslandStore.getState().queue[0]).toMatchObject({ kind: "media", trackId: "track-b" });
  });

  it("surfaces the latest media item after the error collapses", () => {
    useDynamicIslandStore.getState().showNotification({
      title: "Playback failed",
      description: "Missing audio",
      trackId: "track-error",
    });
    vi.advanceTimersByTime(60);
    useDynamicIslandStore.getState().showMediaNotification("track-a");
    useDynamicIslandStore.getState().showMediaNotification("track-b");

    useDynamicIslandStore.getState().dismissNotification();
    vi.advanceTimersByTime(240 + 60);

    expect(useDynamicIslandStore.getState().current).toMatchObject({ kind: "media", trackId: "track-b" });
  });

  it("auto-dismisses a media card after the standard delay", () => {
    useDynamicIslandStore.getState().showMediaNotification("track-auto");
    vi.advanceTimersByTime(60);
    expect(useDynamicIslandStore.getState().stage).toBe("expanded");

    vi.advanceTimersByTime(3000);
    expect(useDynamicIslandStore.getState().stage).toBe("collapsing");

    vi.advanceTimersByTime(240);
    expect(useDynamicIslandStore.getState().current).toBeNull();
    expect(useDynamicIslandStore.getState().stage).toBe("idle");
  });

  it("refreshes the dismissal countdown on repeated same-track media events", () => {
    useDynamicIslandStore.getState().showMediaNotification("track-refresh");
    vi.advanceTimersByTime(60);

    // Consume most of the countdown, then an explicit repeat re-triggers it.
    vi.advanceTimersByTime(2500);
    useDynamicIslandStore.getState().showMediaNotification("track-refresh");

    vi.advanceTimersByTime(2500);
    expect(useDynamicIslandStore.getState().stage).toBe("expanded");

    vi.advanceTimersByTime(600);
    expect(useDynamicIslandStore.getState().stage).toBe("collapsing");
  });

  it("does not refresh the countdown while dismissal is paused", () => {
    useDynamicIslandStore.getState().showMediaNotification("track-paused");
    vi.advanceTimersByTime(60);

    // Consume half the countdown, then pause via hover/focus/touch.
    vi.advanceTimersByTime(1500);
    useDynamicIslandStore.getState().pauseAutoDismiss();
    useDynamicIslandStore.getState().showMediaNotification("track-paused");

    vi.advanceTimersByTime(3000);
    expect(useDynamicIslandStore.getState().stage).toBe("expanded");

    useDynamicIslandStore.getState().resumeAutoDismiss();
    vi.advanceTimersByTime(1600);
    expect(useDynamicIslandStore.getState().stage).toBe("collapsing");
  });

  it("an error notification preempts an active media card", () => {
    useDynamicIslandStore.getState().showMediaNotification("track-media");
    vi.advanceTimersByTime(60);
    expect(useDynamicIslandStore.getState().current?.kind).toBe("media");

    useDynamicIslandStore.getState().showNotification({
      title: "Playback failed",
      description: "Missing audio",
      trackId: "track-media",
    });

    expect(useDynamicIslandStore.getState().current).toMatchObject({
      title: "Playback failed",
      trackId: "track-media",
    });
    expect(useDynamicIslandStore.getState().current?.kind).toBeUndefined();
    expect(useDynamicIslandStore.getState().queue).toHaveLength(0);
  });

  it("ignores empty track ids", () => {
    useDynamicIslandStore.getState().showMediaNotification("");
    expect(useDynamicIslandStore.getState().current).toBeNull();
    expect(useDynamicIslandStore.getState().stage).toBe("idle");
  });
});
