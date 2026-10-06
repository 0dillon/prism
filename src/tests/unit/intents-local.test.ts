import { describe, expect, it } from "vitest";
import { matchSessionIntent, normalizeUtterance } from "@/lib/ai/intents/local";
import { SessionIntent } from "@/lib/schemas/intents";

const PHRASINGS: Array<[SessionIntent, string[]]> = [
  [
    { type: "next" },
    [
      "start",
      "Begin the lesson",
      "let's go",
      "next",
      "Next one",
      "go to the next part",
      "move on",
      "Okay, next!",
      "skip this",
      "I'm ready",
    ],
  ],
  [
    { type: "previous" },
    ["previous", "go back", "Back", "go to the previous section", "take me back", "the last one"],
  ],
  [
    { type: "repeat" },
    [
      "repeat that",
      "Say that again",
      "can you repeat that please",
      "one more time",
      "read it again",
      "what was that?",
      "I missed that",
      "pardon",
    ],
  ],
  [
    { type: "simplify" },
    [
      "simplify",
      "make it simpler",
      "Make that easier",
      "I don't understand",
      "I'm confused",
      "that's too hard",
      "explain it more simply",
      "use simpler words",
    ],
  ],
  [
    { type: "elaborate" },
    ["tell me more", "more detail", "go deeper", "elaborate", "explain more"],
  ],
  [
    { type: "example" },
    ["give me an example", "example", "show me an example", "any examples?", "for example"],
  ],
  [
    { type: "quiz_me" },
    [
      "quiz me",
      "Test me!",
      "give me a quiz",
      "ask me a question",
      "let's do a quiz",
      "check my understanding",
      "I want to take a quiz",
    ],
  ],
  [
    { type: "pause" },
    [
      "pause",
      "stop",
      "wait",
      "hold on",
      "hang on",
      "give me a minute",
      "one sec",
      "pause the lesson",
    ],
  ],
  [
    { type: "resume" },
    ["resume", "continue", "keep going", "carry on", "unpause", "let's continue"],
  ],
  [
    { type: "where_am_i" },
    [
      "where am I",
      "Where are we?",
      "where was I",
      "what are we on",
      "how far along am I",
      "what's left",
      "how much is left",
      "what's this about",
    ],
  ],
  [
    { type: "set_rate", direction: "slower" },
    [
      "slower",
      "slow down",
      "speak slower",
      "too fast",
      "you're going too fast",
      "read more slowly",
    ],
  ],
  [
    { type: "set_rate", direction: "faster" },
    ["faster", "speed up", "talk faster", "too slow", "you're going too slow", "hurry up"],
  ],
];

describe("local session commands: phrasings", () => {
  for (const [intent, phrases] of PHRASINGS) {
    const name = intent.type === "set_rate" ? `${intent.type} ${intent.direction}` : intent.type;
    describe(name, () => {
      it("has at least three phrasings under test", () => {
        expect(phrases.length).toBeGreaterThanOrEqual(3);
      });
      it.each(phrases)("%s", (phrase) => {
        expect(matchSessionIntent(phrase)).toEqual(intent);
      });
    });
  }

  it("returns something that is always a valid SessionIntent", () => {
    for (const [, phrases] of PHRASINGS) {
      for (const phrase of phrases) {
        expect(SessionIntent.safeParse(matchSessionIntent(phrase)).success).toBe(true);
      }
    }
  });

  it("covers the six commands the PRD requires", () => {
    const types = new Set(PHRASINGS.map(([intent]) => intent.type));
    for (const required of ["next", "repeat", "simplify", "quiz_me", "pause", "where_am_i"]) {
      expect(types.has(required as SessionIntent["type"])).toBe(true);
    }
  });
});

describe("local session commands: ways of saying it", () => {
  it("ignores case, punctuation, spacing and curly apostrophes", () => {
    expect(matchSessionIntent("  QUIZ   ME!!!  ")).toEqual({ type: "quiz_me" });
    expect(matchSessionIntent("what’s left?")).toEqual({ type: "where_am_i" });
    expect(matchSessionIntent("next...")).toEqual({ type: "next" });
  });

  it("ignores politeness before and after", () => {
    for (const phrase of [
      "please repeat that",
      "could you please repeat that",
      "hey prism, can you repeat that",
      "repeat that please",
      "repeat that, thanks",
      "would you repeat that for me",
    ]) {
      expect(matchSessionIntent(phrase), phrase).toEqual({ type: "repeat" });
    }
  });

  it("keeps a bare 'again' as a command", () => {
    expect(matchSessionIntent("again")).toEqual({ type: "repeat" });
  });

  it("returns a fresh object each time, so callers cannot change the rules", () => {
    const a = matchSessionIntent("next")!;
    const b = matchSessionIntent("next")!;
    expect(a).not.toBe(b);
    Object.assign(a, { type: "pause" });
    expect(matchSessionIntent("next")).toEqual({ type: "next" });
  });
});

describe("local session commands: what it must not guess", () => {
  it.each([
    "can you go over that again but easier",
    "repeat that and then quiz me",
    "go back to the part about evaporation",
    "what is condensation",
    "why does water evaporate",
    "the answer is B",
    "make the text bigger",
    "next to the river",
    "i want to go home",
    "tell me more about clouds",
    "give me an example of precipitation",
    "I don't understand why the sun heats the water",
  ])("hands %j to the model", (phrase) => {
    expect(matchSessionIntent(phrase)).toBeNull();
  });

  it("returns null for nothing at all", () => {
    expect(matchSessionIntent("")).toBeNull();
    expect(matchSessionIntent("   ")).toBeNull();
    expect(matchSessionIntent("?!.")).toBeNull();
    expect(matchSessionIntent("please")).toBeNull();
  });

  it("returns null for a very long utterance without scanning it", () => {
    expect(matchSessionIntent("next ".repeat(200))).toBeNull();
  });

  it("does not match a command hidden inside a longer sentence", () => {
    expect(matchSessionIntent("I will pause when I need to")).toBeNull();
    expect(matchSessionIntent("the next one is harder than quiz")).toBeNull();
  });

  it("does not take a quiz answer for a command", () => {
    // Single words that are valid answers must not be eaten. These are not commands.
    for (const answer of ["evaporation", "true", "false", "a", "b", "c", "d", "yes", "no"]) {
      expect(matchSessionIntent(answer), answer).toBeNull();
    }
  });
});

describe("local session commands: speed", () => {
  it("answers in well under the 50 ms the PRD allows", () => {
    const start = performance.now();
    for (let i = 0; i < 1000; i++) matchSessionIntent("could you please make that a bit easier");
    expect((performance.now() - start) / 1000).toBeLessThan(5);
  });

  it("does not hang on pathological input", () => {
    const start = performance.now();
    matchSessionIntent("go to the " + "the ".repeat(18) + "!");
    expect(performance.now() - start).toBeLessThan(50);
  });
});

describe("normalizeUtterance", () => {
  it("strips punctuation, case and politeness", () => {
    expect(normalizeUtterance("Hey Prism, could you PLEASE say that again?!")).toBe(
      "say that again",
    );
  });
  it("leaves a plain command alone", () => {
    expect(normalizeUtterance("next")).toBe("next");
  });
});
