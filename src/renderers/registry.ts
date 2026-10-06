import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import type { Layout } from "@/lib/schemas/render-profile";
import type { RendererProps } from "./types";

/**
 * Maps a layout to its renderer component, loaded on demand (PRD 5.5). Only the layout in
 * use is downloaded up front; the others are prefetched after the first paint so a switch
 * needs no wait and no network request.
 */

type Loader = () => Promise<{ default: ComponentType<RendererProps> }>;

export const LAYOUTS = [
  "reader",
  "cards",
  "conversation",
  "visual",
] as const satisfies readonly Layout[];

export const rendererLoaders: Record<Layout, Loader> = {
  cards: () => import("./cards/CardsRenderer"),
  reader: () => import("./reader/ReaderRenderer"),
  conversation: () => import("./conversation/ConversationRenderer"),
  visual: () => import("./visual/VisualRenderer"),
};

/** Spoken and shown when the layout changes. */
export const LAYOUT_LABELS: Record<Layout, string> = {
  reader: "reading",
  cards: "cards",
  conversation: "conversation",
  visual: "visual",
};

/**
 * One lazy component per layout, created once at module load so React sees a stable
 * component identity. Each downloads its bundle the first time it is rendered.
 */
export const renderers: Record<Layout, LazyExoticComponent<ComponentType<RendererProps>>> = {
  cards: lazy(() => rendererLoaders.cards()),
  reader: lazy(() => rendererLoaders.reader()),
  conversation: lazy(() => rendererLoaders.conversation()),
  visual: lazy(() => rendererLoaders.visual()),
};

/** Resolves a layout's component directly. Used to prefetch and in tests. */
export async function loadRenderer(layout: Layout): Promise<ComponentType<RendererProps>> {
  return (await rendererLoaders[layout]()).default;
}

/** Starts downloading renderer bundles. Failures are ignored: the layout loads when it is needed. */
export function prefetchRenderers(layouts: readonly Layout[] = LAYOUTS): void {
  for (const layout of layouts) void rendererLoaders[layout]().catch(() => {});
}
