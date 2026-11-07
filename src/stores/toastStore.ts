import { create } from "zustand";

export type ToastKind = "info" | "success" | "error";

export type Toast = {
  id: number;
  kind: ToastKind;
  message: string;
};

let nextToastId = 1;

type ToastState = {
  toasts: Toast[];
  push: (kind: ToastKind, message: string) => void;
  dismiss: (id: number) => void;
};

const AUTO_DISMISS_MS: Record<ToastKind, number> = {
  info: 4000,
  success: 3500,
  error: 7000,
};

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  push: (kind, message) => {
    const id = nextToastId++;
    set({ toasts: [...get().toasts, { id, kind, message }] });
    setTimeout(() => get().dismiss(id), AUTO_DISMISS_MS[kind]);
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((toast) => toast.id !== id) }),
}));

export function toast(kind: ToastKind, message: string): void {
  useToastStore.getState().push(kind, message);
}
