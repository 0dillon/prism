"use client";

import { AlertDialog } from "radix-ui";
import type { ReactNode } from "react";

interface ConfirmDialogProps {
  /** The element that opens the dialog, usually a Button. */
  trigger: ReactNode;
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
}

/**
 * A confirmation step for actions that cannot be undone. Built on Radix AlertDialog, which
 * traps focus, closes on Escape, labels the dialog from its title and description, and
 * returns focus to the trigger. Cancel is the default focus so Enter is safe.
 */
export function ConfirmDialog({
  trigger,
  title,
  description,
  confirmLabel,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <AlertDialog.Root>
      <AlertDialog.Trigger asChild>{trigger}</AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <AlertDialog.Content className="bg-background text-foreground border-line fixed top-1/2 left-1/2 z-50 w-[min(90vw,28rem)] -translate-x-1/2 -translate-y-1/2 rounded-lg border p-6 shadow-xl">
          <AlertDialog.Title className="text-xl font-semibold">{title}</AlertDialog.Title>
          <AlertDialog.Description className="text-muted mt-2">
            {description}
          </AlertDialog.Description>
          <div className="mt-6 flex flex-wrap justify-end gap-3">
            <AlertDialog.Cancel className="bg-background text-foreground border-line min-h-11 min-w-11 cursor-pointer rounded-md border px-4 py-2 font-semibold">
              Cancel
            </AlertDialog.Cancel>
            <AlertDialog.Action
              onClick={onConfirm}
              className="bg-danger text-background min-h-11 min-w-11 cursor-pointer rounded-md border border-transparent px-4 py-2 font-semibold"
            >
              {confirmLabel}
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
