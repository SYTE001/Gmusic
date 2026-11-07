import { useState, type ReactNode } from "react";
import { Modal } from "./Modal";
import { WarningIcon } from "./Icons";

/**
 * Confirmation for destructive actions (rules §10). Descriptions must
 * distinguish app-data removal from touching the user's source files.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  danger = true,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal open={open} title={title} onClose={busy ? () => undefined : onCancel} width="max-w-sm">
      <div className="flex gap-3">
        {danger && (
          <span className="mt-0.5 text-danger" aria-hidden>
            <WarningIcon size={20} />
          </span>
        )}
        <div className="text-sm text-text-secondary">{description}</div>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <button
          type="button"
          className="rounded-lg px-4 py-2 text-sm text-text-secondary hover:bg-surface-hover hover:text-text-primary transition-colors"
          onClick={onCancel}
          disabled={busy}
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
            danger ? "bg-danger/15 text-danger hover:bg-danger/25" : "bg-accent-strong text-accent-contrast hover:opacity-90"
          }`}
          onClick={() => {
            setBusy(true);
            onConfirm();
          }}
          disabled={busy}
        >
          {busy ? "Working…" : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
