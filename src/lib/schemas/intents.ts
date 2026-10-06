import { z } from "zod";

/**
 * In-session commands (PRD 5.4 B). Common phrasings are matched locally; only
 * unmatched utterances go to the LLM, which must answer with one of these.
 */
export const SessionIntent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("next") }),
  z.object({ type: z.literal("previous") }),
  z.object({ type: z.literal("repeat") }),
  z.object({ type: z.literal("simplify") }),
  z.object({ type: z.literal("elaborate") }),
  z.object({ type: z.literal("example") }),
  z.object({ type: z.literal("quiz_me") }),
  z.object({ type: z.literal("answer"), value: z.string() }),
  z.object({ type: z.literal("pause") }),
  z.object({ type: z.literal("resume") }),
  z.object({ type: z.literal("where_am_i") }),
  z.object({ type: z.literal("go_to"), target: z.string() }), // section or concept title
  z.object({ type: z.literal("set_rate"), direction: z.enum(["slower", "faster"]) }),
  z.object({ type: z.literal("change_profile"), request: z.string() }), // forwards to parser A
  z.object({ type: z.literal("question"), text: z.string() }), // free question about the lesson
  z.object({ type: z.literal("unknown") }),
]);
export type SessionIntent = z.infer<typeof SessionIntent>;
