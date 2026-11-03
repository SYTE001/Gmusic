import { create } from "zustand";

export type NotificationPayload = {
  title: string;
  description: string;
  song?: string;
  trackId?: string;
  category?: string;
};

export type NotificationItem = NotificationPayload & {
  id: string;
  key: string;
};

export type IslandAnimationStage = "idle" | "initial" | "expanded" | "collapsing";

type DynamicIslandStore = {
  current: NotificationItem | null;
  stage: IslandAnimationStage;
  queue: NotificationItem[];
  showNotification: (payload: NotificationPayload) => void;
  dismissNotification: () => void;
  /** For testing or resetting state */
  reset: () => void;
};

let nextId = 0;
let expandTimeout: ReturnType<typeof setTimeout> | null = null;
let autoDismissTimeout: ReturnType<typeof setTimeout> | null = null;
let collapseTimeout: ReturnType<typeof setTimeout> | null = null;

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
}

const MAX_QUEUE_SIZE = 3;
const AUTO_DISMISS_DELAY_MS = 3000;
const EXPAND_DELAY_MS = 60;
const COLLAPSE_DURATION_MS = 240;

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

    if (!state.current || state.stage === "idle" || state.stage === "collapsing") {
      clearAllTimers();
      set({ current: newItem, stage: "initial" });

      expandTimeout = setTimeout(() => {
        set({ stage: "expanded" });
        autoDismissTimeout = setTimeout(() => {
          get().dismissNotification();
        }, AUTO_DISMISS_DELAY_MS);
      }, EXPAND_DELAY_MS);
      return;
    }

    // Queue with bounded capacity
    const boundedQueue = state.queue.length >= MAX_QUEUE_SIZE ? state.queue.slice(1) : state.queue;
    set({ queue: [...boundedQueue, newItem] });
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
          autoDismissTimeout = setTimeout(() => {
            get().dismissNotification();
          }, AUTO_DISMISS_DELAY_MS);
        }, EXPAND_DELAY_MS);
      } else {
        set({ current: null, stage: "idle" });
      }
    }, COLLAPSE_DURATION_MS);
  },

  reset: () => {
    clearAllTimers();
    set({ current: null, stage: "idle", queue: [] });
  },
}));
