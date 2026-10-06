import { describe, expect, it } from "vitest";
import { splitSentences } from "@/lib/speech/sentences";

const both = [
  ["Intl.Segmenter", true],
  ["the fallback", false],
] as const;

describe.each(both)("splitSentences with %s", (_name, useSegmenter) => {
  const split = (text: string) => splitSentences(text, { useSegmenter });

  it("splits ordinary sentences", () => {
    expect(split("Water moves. It rises! Does it fall?").map((s) => s.text)).toEqual([
      "Water moves.",
      "It rises!",
      "Does it fall?",
    ]);
  });

  it("keeps the position of each sentence in the original text", () => {
    const text = "One here.  Two there.";
    for (const s of split(text)) expect(text.slice(s.start, s.end)).toBe(s.text);
  });

  it("returns a single sentence for text with no ending punctuation", () => {
    expect(split("A heading with no full stop").map((s) => s.text)).toEqual([
      "A heading with no full stop",
    ]);
  });

  it("returns nothing for empty or blank text", () => {
    expect(split("")).toEqual([]);
    expect(split("   \n ")).toEqual([]);
  });

  it("does not split on a decimal number", () => {
    expect(split("It rained 3.5 litres today. Then it stopped.").map((s) => s.text)).toEqual([
      "It rained 3.5 litres today.",
      "Then it stopped.",
    ]);
  });

  it("keeps a closing quote with its sentence", () => {
    const texts = split('He said "go." Then he left.').map((s) => s.text);
    expect(texts.join(" ")).toContain('"go."');
    expect(texts).toHaveLength(2);
  });

  it("covers all of the text, apart from spaces between sentences", () => {
    const text = "Alpha one. Beta two? Gamma three!";
    expect(
      split(text)
        .map((s) => s.text)
        .join(" "),
    ).toBe(text);
  });

  it("never returns an empty sentence or one with spaces at the edges", () => {
    for (const s of split("  A.   B.  \n\n  C  ")) {
      expect(s.text).toBe(s.text.trim());
      expect(s.text.length).toBeGreaterThan(0);
    }
  });
});

describe("splitSentences: the fallback's abbreviations", () => {
  it("does not end a sentence at e.g. or Dr.", () => {
    const texts = splitSentences("Plants, e.g. ferns, need light. Dr. Lee agrees.", {
      useSegmenter: false,
    }).map((s) => s.text);
    expect(texts).toEqual(["Plants, e.g. ferns, need light.", "Dr. Lee agrees."]);
  });
});
