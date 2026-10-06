import type { ProfilePatch } from "@/lib/profile/merge";
import type { LessonSession } from "@/lib/session/machine";
import type { KnowledgeGraph } from "@/lib/schemas/knowledge-graph";
import type { RenderProfile } from "@/lib/schemas/render-profile";

/** The session actions a renderer can call. Renderers never decide what happens next. */
export interface SessionActions {
  start(): void;
  next(): void;
  previous(): void;
  requestQuiz(): void;
  answer(quizItemId: string, correct: boolean): void;
  continue(): void;
  goTo(conceptIndex: number): void;
  restart(): void;
}

/**
 * Every renderer receives exactly these props (PRD 5.5). A renderer is a view: it draws
 * `session` and `profile` and calls `actions`. It keeps no progress of its own.
 *
 * Accessibility contract: the renderer's main heading carries `data-renderer-heading`
 * and tabIndex -1, so PrismRenderer can move focus to it after a layout switch.
 */
export interface RendererProps {
  graph: KnowledgeGraph;
  session: LessonSession;
  profile: RenderProfile;
  actions: SessionActions;
  /**
   * Changes a setting from inside the lesson, such as the read-aloud speed. The profile
   * stays the one source of truth: the renderer asks, and receives the result as a new
   * `profile` prop.
   */
  updateProfile: (patch: ProfilePatch) => void;
}

export const RENDERER_HEADING_ATTRIBUTE = "data-renderer-heading";
