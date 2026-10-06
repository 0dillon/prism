"use client";

import { Dialog } from "radix-ui";
import { Button } from "@/components/Button";
import { SHORTCUTS } from "./shortcuts";

interface ShortcutsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** The keyboard shortcuts, listed where a learner can find them (PRD 5.6.3, P4-21). */
export function ShortcutsDialog({ open, onOpenChange }: ShortcutsDialogProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content className="bg-background text-foreground border-line fixed top-1/2 left-1/2 z-50 flex w-[min(95vw,28rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-lg border p-6 shadow-xl">
          <Dialog.Title className="text-xl font-semibold">Keyboard shortcuts</Dialog.Title>
          <Dialog.Description className="text-muted">
            These work when you are not typing in a box. Pressing any key also stops Prism talking.
          </Dialog.Description>
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
            {SHORTCUTS.map((shortcut) => (
              <div key={shortcut.key} className="col-span-2 grid grid-cols-subgrid">
                <dt>
                  <kbd className="border-line bg-surface rounded border px-2 py-1 font-mono">
                    {shortcut.label}
                  </kbd>
                </dt>
                <dd>{shortcut.description}</dd>
              </div>
            ))}
          </dl>
          <div className="flex justify-end">
            <Dialog.Close asChild>
              <Button>Close</Button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
