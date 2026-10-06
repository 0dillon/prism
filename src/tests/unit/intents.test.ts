import { describe, expect, it } from "vitest";
import { SessionIntent } from "@/lib/schemas/intents";

describe("SessionIntent", () => {
  it.each([
    [{ type: "next" }],
    [{ type: "repeat" }],
    [{ type: "answer", value: "B" }],
    [{ type: "go_to", target: "Condensation" }],
    [{ type: "set_rate", direction: "slower" }],
    [{ type: "change_profile", request: "bigger text" }],
    [{ type: "question", text: "Why is the sky blue?" }],
    [{ type: "unknown" }],
  ])("accepts %j", (intent) => {
    expect(SessionIntent.parse(intent)).toEqual(intent);
  });

  it.each([
    ["an unknown type", { type: "teleport" }],
    ["an answer without a value", { type: "answer" }],
    ["go_to without a target", { type: "go_to" }],
    ["an invalid rate direction", { type: "set_rate", direction: "sideways" }],
    ["a non-string question", { type: "question", text: 4 }],
    ["a missing type", {}],
  ])("rejects %s", (_name, intent) => {
    expect(SessionIntent.safeParse(intent).success).toBe(false);
  });

  it("covers every intent in the PRD", () => {
    const types = SessionIntent.options.map((option) => option.shape.type.value);
    expect(types).toEqual([
      "next",
      "previous",
      "repeat",
      "simplify",
      "elaborate",
      "example",
      "quiz_me",
      "answer",
      "pause",
      "resume",
      "where_am_i",
      "go_to",
      "set_rate",
      "change_profile",
      "question",
      "unknown",
    ]);
  });
});
