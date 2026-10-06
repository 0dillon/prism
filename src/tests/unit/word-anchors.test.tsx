// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { anchorWords, splitWordAnchor } from "@/renderers/reader/wordAnchors";
import { expectNoAxeViolations } from "../a11y";

describe("splitWordAnchor", () => {
  it.each([
    ["water", "wa", "ter"],
    ["a", "a", ""],
    ["it", "i", "t"],
    ["the", "th", "e"],
    ["cold", "co", "ld"],
    ["vapor", "va", "por"],
    ["condensation", "conde", "nsation"],
    ["precipitation", "precip", "itation"],
  ])("anchors %s as %s + %s", (word, lead, rest) => {
    expect(splitWordAnchor(word)).toEqual({ prefix: "", lead, rest });
  });

  it("always bolds at least one letter and never the whole of a longer word", () => {
    for (const word of ["a", "I", "go", "sun", "rain", "clouds", "evaporation"]) {
      const { lead, rest } = splitWordAnchor(word);
      expect(lead.length).toBeGreaterThanOrEqual(1);
      if (word.length > 1) expect(rest.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("keeps punctuation out of the bold part", () => {
    expect(splitWordAnchor("rain,")).toEqual({ prefix: "", lead: "ra", rest: "in," });
    expect(splitWordAnchor("(clouds)")).toEqual({ prefix: "(", lead: "clo", rest: "uds)" });
    expect(splitWordAnchor('"Water')).toEqual({ prefix: '"', lead: "Wa", rest: "ter" });
    expect(splitWordAnchor("vapor.")).toEqual({ prefix: "", lead: "va", rest: "por." });
  });

  it("treats an apostrophe or hyphen inside a word as part of it", () => {
    expect(splitWordAnchor("don't")).toEqual({ prefix: "", lead: "do", rest: "n't" });
    expect(splitWordAnchor("well-known")).toEqual({ prefix: "", lead: "well", rest: "-known" });
  });

  it("leaves numbers and symbols alone", () => {
    for (const token of ["2024", "3.5", "—", "%", "&", "..."]) {
      expect(splitWordAnchor(token)).toEqual({ prefix: "", lead: "", rest: token });
    }
  });

  it("anchors a word with a number in it", () => {
    expect(splitWordAnchor("H2O").lead).toBe("H2");
  });

  it("does not cut an accented letter or other multi-code-unit character in half", () => {
    expect(splitWordAnchor("élève")).toEqual({ prefix: "", lead: "él", rest: "ève" });
    expect(splitWordAnchor("𝒲ater").lead.length).toBeGreaterThan(0);
    const { lead, rest } = splitWordAnchor("naïve");
    expect(lead + rest).toBe("naïve");
  });

  it("never loses or adds a character", () => {
    for (const token of ["", "x", "(a)", "—", "co-op!", "123abc", "'quoted'", "naïve,", "A.B.C."]) {
      const { prefix, lead, rest } = splitWordAnchor(token);
      expect(prefix + lead + rest).toBe(token);
    }
  });

  it("copes with an empty token", () => {
    expect(splitWordAnchor("")).toEqual({ prefix: "", lead: "", rest: "" });
  });
});

describe("anchorWords", () => {
  const sentence = "Water moves, then it rises (slowly) — for 3.5 days.";

  it("returns the text untouched when anchors are off", () => {
    expect(anchorWords(sentence, false)).toBe(sentence);
    expect(anchorWords("", true)).toBe("");
  });

  it("leaves the text content exactly as it was, spaces included", () => {
    const { container } = render(<p>{anchorWords(sentence)}</p>);
    expect(container.textContent).toBe(sentence);
    const spaced = "  two   spaces\tand\na newline ";
    const second = render(<p>{anchorWords(spaced)}</p>);
    expect(second.container.textContent).toBe(spaced);
  });

  it("bolds only the start of words", () => {
    const { container } = render(<p>{anchorWords("Water rises")}</p>);
    expect([...container.querySelectorAll("b")].map((b) => b.textContent)).toEqual(["Wa", "ri"]);
  });

  it("does not bold numbers or symbols", () => {
    const { container } = render(<p>{anchorWords("3.5 — 2024")}</p>);
    expect(container.querySelectorAll("b")).toHaveLength(0);
  });

  it("gives a control the same accessible name as the plain text", () => {
    render(<button type="button">{anchorWords("Show the next idea")}</button>);
    expect(screen.getByRole("button", { name: "Show the next idea" })).toBeInTheDocument();
  });

  it("does not add roles, labels or hidden text to hide anything from a screen reader", () => {
    const { container } = render(<p>{anchorWords("Water moves")}</p>);
    expect(container.querySelector("[aria-label],[aria-hidden],[role],.sr-only")).toBeNull();
  });

  it("keeps a heading's accessible name plain", () => {
    render(<h2>{anchorWords("Condensation and clouds")}</h2>);
    expect(screen.getByRole("heading", { name: "Condensation and clouds" })).toBeInTheDocument();
  });

  it("has no axe violations", async () => {
    const { container } = render(<p>{anchorWords(sentence)}</p>);
    await expectNoAxeViolations(container);
  });
});
