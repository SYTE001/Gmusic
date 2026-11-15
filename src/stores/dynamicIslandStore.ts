import { create } from "zustand";

export type NotificationPayload = {
  title: string;
  description: string;
  song?: string;
  trackId?: string;
  category?: string;
  errorCode?: string;
};

export type NotificationItem = NotificationPayload & {
  id: string;
  key: string;
  /**
   * Distinguishes transient media cards from error alerts. Error items keep
   * this undefined so existing consumers and tests are unaffected.
   */
  kind?: "error" | "media";
};

export type IslandAnimationStage = "idle" | "initial" | "expanded" | "collapsing";

type DynamicIslandStore = {
  current: NotificationItem | null;
  stage: IslandAnimationStage;
  queue: NotificationItem[];
  showNotification: (payload: NotificationPayload) => void;
  /**
   * Presents the floating media card for a playing track. Frequent playback
   * events (start/play/pause/seek) are deduplicated per track; repeated
   * same-track events refresh the dismissal countdown only while the user has
   * not paused it (hover/focus/touch). An active error card is never
   * overwritten: media waits in the queue until the error collapses.
   */
  showMediaNotification: (trackId: string) => void;
  dismissNotification: () => void;
  pauseAutoDismiss: () => void;
  resumeAutoDismiss: () => void;
  /** For testing or resetting state */
  reset: () => void;
};

let nextId = 0;
let expandTimeout: ReturnType<typeof setTimeout> | null = null;
let autoDismissTimeout: ReturnType<typeof setTimeout> | null = null;
let collapseTimeout: ReturnType<typeof setTimeout> | null = null;
let autoDismissStartedAt: number | null = null;
let autoDismissRemainingMs: number = 3000;
let isPaused: boolean = false;

function clearAllTimers() {
  if (expandTimeout) {
    clearTimeout(expandTimeout);
    expandTimeout = null;
  }
  if (autoDismissTimeout) {
    clearTimeout(autoDismissTimeout);
    autoDismissTimeout = null;
  }
  if (collapseTimeout) {
    clearTimeout(collapseTimeout);
    collapseTimeout = null;
  }
  autoDismissStartedAt = null;
  isPaused = false;
  autoDismissRemainingMs = AUTO_DISMISS_DELAY_MS;
}

const MAX_QUEUE_SIZE = 3;
const AUTO_DISMISS_DELAY_MS = 3000;
const EXPAND_DELAY_MS = 60;
const COLLAPSE_DURATION_MS = 240;

function scheduleAutoDismiss(onDismiss: () => void, delayMs: number) {
  if (autoDismissTimeout) {
    clearTimeout(autoDismissTimeout);
    autoDismissTimeout = null;
  }
  autoDismissRemainingMs = delayMs;
  autoDismissStartedAt = Date.now();
  isPaused = false;
  autoDismissTimeout = setTimeout(() => {
    onDismiss();
  }, delayMs);
}

export const useDynamicIslandStore = create<DynamicIslandStore>((set, get) => ({
  current: null,
  stage: "idle",
  queue: [],

  showNotification: (payload) => {
    const key = `${payload.trackId ?? ""}:${payload.title}:${payload.description}`;
    const state = get();

    // Deduplication: prevent duplicate notifications for same track and error
    if (state.current?.key === key && state.stage !== "collapsing") {
      return;
    }
    if (state.queue.some((item) => item.key === key)) {
      return;
    }

    const newItem: NotificationItem = {
      ...payload,
      id: `din-${++nextId}-${Date.now()}`,
      key,
    };

    // Errors take priority over a transient media card: replace it in place.
    // During a collapse the pending promotion timer owns `current`, so the
    // error queues instead of racing the collapse (this also removes the old
    // latent bug where a collapse timeout could clear a just-shown item).
    if (
      !state.current ||
      state.stage === "idle" ||
      (state.current.kind === "media" && state.stage !== "collapsing")
    ) {
      clearAllTimers();
      set({ current: newItem, stage: "initial" });

      expandTimeout = setTimeout(() => {
        set({ stage: "expanded" });
        scheduleAutoDismiss(() => get().dismissNotification(), AUTO_DISMISS_DELAY_MS);
      }, EXPAND_DELAY_MS);
      return;
    }

    // Queue with bounded capacity
    const boundedQueue = state.queue.length >= MAX_QUEUE_SIZE ? state.queue.slice(1) : state.queue;
    set({ queue: [...boundedQueue, newItem] });
  },

  showMediaNotification: (trackId) => {
    if (!trackId) return;
    const key = `media:${trackId}`;
    const state = get();

    if (state.queue.some((item) => item.key === key)) {
      return;
    }

    // Same track already showing: dedupe frequent play/pause/seek events, but
    // refresh the dismissal countdown so an explicitly re-triggered card stays
    // visible — unless the user paused it via hover/focus/touch.
    if (state.current?.key === key && state.stage !== "collapsing") {
      if (state.stage === "expanded" && !isPaused) {
        scheduleAutoDismiss(() => get().dismissNotification(), AUTO_DISMISS_DELAY_MS);
      }
      return;
    }

    const newItem: NotificationItem = {
      kind: "media",
      trackId,
      title: "",
      description: "",
      id: `din-${++nextId}-${Date.now()}`,
      key,
    };

    const presentItem = () => {
      clearAllTimers();
      set({ current: newItem, stage: "initial" });
      expandTimeout = setTimeout(() => {
        set({ stage: "expanded" });
        scheduleAutoDismiss(() => get().dismissNotification(), AUTO_DISMISS_DELAY_MS);
      }, EXPAND_DELAY_MS);
    };

    // Nothing on screen: present immediately.
    if (!state.current || state.stage === "idle") {
      presentItem();
      return;
    }

    // Never overwrite an active error (or a card mid-collapse whose promotion
    // timer owns `current`): the media item waits in the queue, and the latest
    // media item replaces any previously queued media.
    if (state.stage === "collapsing" || state.current.kind !== "media") {
      const others = state.queue.filter((item) => item.kind !== "media");
      const bounded = others.length >= MAX_QUEUE_SIZE ? others.slice(1) : others;
      set({ queue: [...bounded, newItem] });
      return;
    }

    // A different track started: replace the active media card in place.
    presentItem();
  },

  dismissNotification: () => {
    const state = get();
    if (!state.current || state.stage === "idle" || state.stage === "collapsing") return;

    clearAllTimers();
    set({ stage: "collapsing" });

    collapseTimeout = setTimeout(() => {
      const latest = get();
      if (latest.queue.length > 0) {
        const [next, ...rest] = latest.queue;
        set({ current: next, queue: rest, stage: "initial" });
        expandTimeout = setTimeout(() => {
          set({ stage: "expanded" });
          scheduleAutoDismiss(() => get().dismissNotification(), AUTO_DISMISS_DELAY_MS);
        }, EXPAND_DELAY_MS);
      } else {
        set({ current: null, stage: "idle" });
      }
    }, COLLAPSE_DURATION_MS);
  },

  pauseAutoDismiss: () => {
    const state = get();
    if (state.stage !== "expanded" || isPaused || !autoDismissStartedAt) return;
    if (autoDismissTimeout) {
      clearTimeout(autoDismissTimeout);
      autoDismissTimeout = null;
    }
    const elapsed = Date.now() - autoDismissStartedAt;
    autoDismissRemainingMs = Math.max(500, autoDismissRemainingMs - elapsed);
    isPaused = true;
  },

  resumeAutoDismiss: () => {
    const state = get();
    if (state.stage !== "expanded" || !isPaused) return;
    scheduleAutoDismiss(() => get().dismissNotification(), autoDismissRemainingMs);
  },

  reset: () => {
    clearAllTimers();
    set({ current: null, stage: "idle", queue: [] });
  },
}));
