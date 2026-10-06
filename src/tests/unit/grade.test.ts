import { describe, expect, it } from "vitest";
import {
  gradeChoice,
  gradeLocally,
  gradeShortAnswerLocally,
  normalizeAnswer,
} from "@/lib/quiz/grade";
import { makeGraph } from "../fixtures/graph";

const [mcq, trueFalse, , short] = makeGraph().quizItems; // mcq, true_false, mcq, short_answer

describe("gradeChoice", () => {
  it("marks the right option correct and any other wrong", () => {
    expect(gradeChoice(mcq, "It turns into vapor")).toEqual({
      correct: true,
      correctAnswer: "It turns into vapor",
    });
    expect(gradeChoice(mcq, "It turns into ice").correct).toBe(false);
  });

  it("is exact: a near match is not the option", () => {
    expect(gradeChoice(mcq, "it turns into vapor").correct).toBe(false);
    expect(gradeChoice(mcq, "").correct).toBe(false);
  });

  it("grades true and false", () => {
    expect(gradeChoice(trueFalse, "true").correct).toBe(true);
    expect(gradeChoice(trueFalse, "false").correct).toBe(false);
  });

  it("reports the correct answer so it can be shown when the learner is wrong", () => {
    expect(gradeChoice(mcq, "x").correctAnswer).toBe("It turns into vapor");
  });
});

describe("normalizeAnswer", () => {
  it.each([
    ["  Condensation! ", "condensation"],
    ["CONDENSATION", "condensation"],
    ["con-den-sation", "condensation"],
    ["résumé", "resume"],
    ["water   vapor", "water vapor"],
    ["It's cold.", "its cold"],
  ])("%j -> %j", (input, expected) => {
    expect(normalizeAnswer(input)).toBe(expected);
  });
});

describe("gradeShortAnswerLocally", () => {
  it("accepts the model answer ignoring case, spacing and punctuation", () => {
    expect(gradeShortAnswerLocally(short, "Condensation").correct).toBe(true);
    expect(gradeShortAnswerLocally(short, "  condensation!  ").correct).toBe(true);
  });

  it("accepts listed alternative phrasings", () => {
    expect(gradeShortAnswerLocally(short, "condensing").correct).toBe(true);
  });

  it("rejects a wrong or blank answer", () => {
    expect(gradeShortAnswerLocally(short, "evaporation").correct).toBe(false);
    expect(gradeShortAnswerLocally(short, "").correct).toBe(false);
    expect(gradeShortAnswerLocally(short, "   ").correct).toBe(false);
    expect(gradeShortAnswerLocally(short, "!!!").correct).toBe(false);
  });

  it("does not accept an answer that merely contains the right word", () => {
    expect(gradeShortAnswerLocally(short, "not condensation").correct).toBe(false);
  });

  it("never treats an empty accepted phrasing as matching a blank answer", () => {
    expect(gradeShortAnswerLocally({ ...short, acceptable: [""] }, "").correct).toBe(false);
  });
});

describe("gradeLocally", () => {
  it("routes each type to its grader", () => {
    expect(gradeLocally(mcq, "It turns into vapor").correct).toBe(true);
    expect(gradeLocally(trueFalse, "true").correct).toBe(true);
    expect(gradeLocally(short, "Condensation").correct).toBe(true);
  });
});
