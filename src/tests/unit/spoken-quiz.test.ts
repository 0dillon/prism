import { describe, expect, it } from "vitest";
import {
  letterFor,
  matchSpokenAnswer,
  spokenOptions,
  spokenQuestion,
} from "@/renderers/conversation/spokenQuiz";
import type { QuizItem } from "@/lib/schemas/knowledge-graph";
import { gradeLocally } from "@/lib/quiz/grade";

const mcq: QuizItem = {
  id: "q1",
  conceptId: "c",
  type: "mcq",
  prompt: "What happens to water during evaporation?",
  options: ["It turns into a gas", "It turns into ice", "It falls as rain", "It sinks underground"],
  answer: "It turns into a gas",
  acceptable: [],
  explanation: "Heat turns it into vapor.",
  difficulty: "recall",
  flags: [],
};
const three: QuizItem = { ...mcq, options: ["Clouds", "Oceans", "Rivers"], answer: "Clouds" };
const tf: QuizItem = {
  ...mcq,
  type: "true_false",
  prompt: "Snow is precipitation.",
  options: undefined,
  answer: "true",
};
const short: QuizItem = {
  ...mcq,
  type: "short_answer",
  prompt: "What is it called?",
  options: undefined,
  answer: "condensation",
};

const choice = (item: QuizItem, said: string) => {
  const result = matchSpokenAnswer(item, said);
  return result.kind === "choice" ? result.value : result.kind;
};

describe("spokenQuestion", () => {
  it("reads the prompt, then each option with its letter, then how to answer", () => {
    expect(spokenQuestion(mcq)).toBe(
      "What happens to water during evaporation? A. It turns into a gas. B. It turns into ice. C. It falls as rain. D. It sinks underground. Say the letter or the answer.",
    );
  });

  it("says true or false first for a true or false question", () => {
    expect(spokenQuestion(tf)).toBe("True or false. Snow is precipitation.");
  });

  it("asks for a spoken or typed answer to a short question", () => {
    expect(spokenQuestion(short)).toBe("What is it called? Say or type your answer.");
  });

  it("copes with a question that has no options", () => {
    expect(spokenQuestion({ ...mcq, options: undefined })).toContain("Say the letter");
  });
});

describe("spokenOptions", () => {
  it("lists the lettered options, or true and false, or nothing", () => {
    expect(spokenOptions(three)).toBe("A. Clouds. B. Oceans. C. Rivers.");
    expect(spokenOptions(tf)).toBe("True, or false.");
    expect(spokenOptions(short)).toBe("");
  });
});

describe("letterFor", () => {
  it("maps positions to letters, and past F to numbers", () => {
    expect([0, 1, 2, 3].map(letterFor)).toEqual(["A", "B", "C", "D"]);
    expect(letterFor(7)).toBe("8");
  });
});

describe("matchSpokenAnswer: a letter", () => {
  it.each([
    ["B", "It turns into ice"],
    ["b", "It turns into ice"],
    ["B.", "It turns into ice"],
    ["option B", "It turns into ice"],
    ["letter b", "It turns into ice"],
    ["answer B", "It turns into ice"],
    ["B please", "It turns into ice"],
    ["I think it's B", "It turns into ice"],
    ["the answer is C", "It falls as rain"],
    ["my answer is d", "It sinks underground"],
    ["A", "It turns into a gas"],
  ])("hears %j as a letter", (said, option) => {
    expect(choice(mcq, said)).toBe(option);
  });

  it.each([
    ["bee", "It turns into ice"],
    ["be", "It turns into ice"],
    ["see", "It falls as rain"],
    ["sea", "It falls as rain"],
    ["dee", "It sinks underground"],
    ["option see", "It falls as rain"],
    ["eh", "It turns into a gas"],
  ])("hears the sound-alike %j", (said, option) => {
    expect(choice(mcq, said)).toBe(option);
  });

  it.each([
    ["the first one", "It turns into a gas"],
    ["second", "It turns into ice"],
    ["the third option", "It falls as rain"],
    ["number 4", "It sinks underground"],
    ["option two", "It turns into ice"],
  ])("hears the position %j", (said, option) => {
    expect(choice(mcq, said)).toBe(option);
  });

  it("does not accept a letter the question does not have", () => {
    expect(choice(three, "D")).toBe("unclear");
    expect(choice(three, "fourth")).toBe("unclear");
  });
});

describe("matchSpokenAnswer: the option's own words", () => {
  it("accepts the whole option, in any case, with or without punctuation", () => {
    expect(choice(mcq, "It turns into a gas")).toBe("It turns into a gas");
    expect(choice(mcq, "it turns into a gas!")).toBe("It turns into a gas");
  });

  it("accepts the distinctive part of an option", () => {
    expect(choice(mcq, "a gas")).toBe("It turns into a gas");
    expect(choice(mcq, "ice")).toBe("It turns into ice");
    expect(choice(mcq, "underground")).toBe("It sinks underground");
    expect(choice(three, "clouds")).toBe("Clouds");
  });

  it("accepts the answer with words around it", () => {
    expect(choice(mcq, "I think it turns into ice")).toBe("It turns into ice");
    expect(choice(three, "it's rivers")).toBe("Rivers");
  });

  it("gives the same answer for the letter and for the words", () => {
    expect(choice(mcq, "B")).toBe(choice(mcq, "it turns into ice"));
    expect(choice(three, "C")).toBe(choice(three, "rivers"));
  });

  it("is unclear when what was said fits two options", () => {
    // "It turns into" is in both A and B.
    expect(choice(mcq, "it turns into")).toBe("unclear");
  });

  it("is unclear for something that is not an option", () => {
    expect(choice(mcq, "banana")).toBe("unclear");
    expect(choice(mcq, "")).toBe("unclear");
    expect(choice(mcq, "   ")).toBe("unclear");
    expect(choice(mcq, "um")).toBe("unclear");
  });

  it("does not take a one or two letter fragment for an option's words", () => {
    expect(choice({ ...mcq, options: ["It is on", "It is off", "It is up"] }, "it")).toBe(
      "unclear",
    );
  });

  it("grades the same way for the letter and the words", () => {
    for (const said of ["A", "a gas", "the first one", "it turns into a gas"]) {
      const result = matchSpokenAnswer(mcq, said);
      expect(result.kind).toBe("choice");
      if (result.kind === "choice") expect(gradeLocally(mcq, result.value).correct).toBe(true);
    }
    const wrong = matchSpokenAnswer(mcq, "B");
    if (wrong.kind === "choice") expect(gradeLocally(mcq, wrong.value).correct).toBe(false);
  });
});

describe("matchSpokenAnswer: true or false", () => {
  it.each([
    ["true", "true"],
    ["True.", "true"],
    ["false", "false"],
    ["it's true", "true"],
    ["I think it is false", "false"],
    ["that's false", "false"],
    ["correct", "true"],
    ["yes", "true"],
    ["no", "false"],
    ["nope", "false"],
    ["false please", "false"],
  ])("hears %j as %s", (said, value) => {
    expect(choice(tf, said)).toBe(value);
  });

  it("is unclear for anything else", () => {
    expect(choice(tf, "banana")).toBe("unclear");
    expect(choice(tf, "maybe")).toBe("unclear");
    expect(choice(tf, "")).toBe("unclear");
    expect(choice(tf, "snow is a kind of precipitation that falls")).toBe("unclear");
  });

  it("grades the spoken answer", () => {
    const yes = matchSpokenAnswer(tf, "true");
    expect(yes.kind === "choice" && gradeLocally(tf, yes.value).correct).toBe(true);
    const no = matchSpokenAnswer(tf, "false");
    expect(no.kind === "choice" && gradeLocally(tf, no.value).correct).toBe(false);
  });
});

describe("matchSpokenAnswer: a short answer", () => {
  it("passes the words on as they were said, trimmed", () => {
    expect(matchSpokenAnswer(short, "  Condensation ")).toEqual({
      kind: "text",
      value: "Condensation",
    });
    expect(matchSpokenAnswer(short, "the answer is condensation")).toEqual({
      kind: "text",
      value: "the answer is condensation",
    });
  });

  it("is unclear for nothing at all", () => {
    expect(matchSpokenAnswer(short, "  ")).toEqual({ kind: "unclear" });
  });
});
