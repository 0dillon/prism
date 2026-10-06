"use client";

import { Tabs } from "radix-ui";
import type { ReactNode } from "react";

interface ReviewTabsProps {
  concepts: ReactNode;
  signs: ReactNode;
  signCount: number;
}

const trigger =
  "min-h-11 cursor-pointer border-b-4 border-transparent px-4 py-2 font-semibold data-[state=active]:border-accent";

/**
 * Concepts and Signs tabs. Both panels stay mounted so edits that are not saved yet are
 * not lost when the teacher switches tabs; the inactive one is just hidden.
 */
export function ReviewTabs({ concepts, signs, signCount }: ReviewTabsProps) {
  return (
    <Tabs.Root defaultValue="concepts" className="flex flex-col gap-6">
      <Tabs.List aria-label="Review sections" className="border-line flex gap-2 border-b">
        <Tabs.Trigger value="concepts" className={trigger}>
          Concepts and questions
        </Tabs.Trigger>
        <Tabs.Trigger value="signs" className={trigger}>
          {`Signs (${signCount})`}
        </Tabs.Trigger>
      </Tabs.List>
      <Tabs.Content value="concepts" forceMount className="data-[state=inactive]:hidden">
        {concepts}
      </Tabs.Content>
      <Tabs.Content value="signs" forceMount className="data-[state=inactive]:hidden">
        {signs}
      </Tabs.Content>
    </Tabs.Root>
  );
}
