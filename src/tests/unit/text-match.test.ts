import { describe, expect, it } from "vitest";
import {
  clampText,
  closestSourcePassage,
  containsExcerpt,
  normalizeForMatch,
} from "@/lib/ai/ingestion/text";

describe("normalizeForMatch", () => {
  it("flattens case, whitespace, quotes, dashes and ellipses", () => {
    expect(normalizeForMatch("  The  “Sun”\nwarms\tit — a lot…  ")).toBe(
      'the "sun" warms it - a lot...',
    );
    expect(normalizeForMatch("It’s")).toBe("it's");
  });

  it("removes zero-width characters and soft hyphens", () => {
    expect(normalizeForMatch("con­den​sation")).toBe("condensation");
  });
});

describe("containsExcerpt", () => {
  const source = "The sun warms water in oceans.\n\nSome of it turns into “vapor” and rises.";

  it("finds a verbatim excerpt", () => {
    expect(containsExcerpt(source, "The sun warms water in oceans.")).toBe(true);
  });

  it("ignores whitespace, case and quote style differences", () => {
    expect(containsExcerpt(source, "the sun   warms water\nin oceans.")).toBe(true);
    expect(containsExcerpt(source, 'turns into "vapor" and rises')).toBe(true);
  });

  it("finds an excerpt that spans a paragraph break", () => {
    expect(containsExcerpt(source, "in oceans. Some of it turns into")).toBe(true);
  });

  it("rejects text that is not in the source", () => {
    expect(containsExcerpt(source, "The moon pulls the tides.")).toBe(false);
    expect(containsExcerpt(source, "warms oceans in water")).toBe(false); // wrong word order
  });

  it("rejects an empty excerpt", () => {
    expect(containsExcerpt(source, "   ")).toBe(false);
  });
});

describe("closestSourcePassage", () => {
  const source = [
    "The sun warms water in oceans, lakes, and rivers. Some of the water turns into vapor.",
    "High in the sky the air is cold. Vapor cools there and turns into tiny droplets.",
    "Droplets gather together to form clouds.",
  ].join("\n\n");

  it("repairs a paraphrase to the source's own sentence", () => {
    const passage = closestSourcePassage(source, "Vapor cools and becomes tiny droplets.");
    expect(passage).toBe("Vapor cools there and turns into tiny droplets.");
  });

  it("returns an exact match unchanged", () => {
    expect(closestSourcePassage(source, "Droplets gather together to form clouds.")).toBe(
      "Droplets gather together to form clouds.",
    );
  });

  it("returns null when nothing is close", () => {
    expect(
      closestSourcePassage(source, "Volcanoes erupt when magma rises through the crust."),
    ).toBeNull();
  });

  it("returns null for a very short excerpt", () => {
    expect(closestSourcePassage(source, "water")).toBeNull();
  });

  it("returns a passage that really appears in the source", () => {
    const passage = closestSourcePassage(source, "the sun warms the water in lakes and rivers");
    expect(passage).not.toBeNull();
    expect(containsExcerpt(source, passage as string)).toBe(true);
  });
});

describe("clampText", () => {
  it("leaves short text alone and trims whitespace", () => {
    expect(clampText("  short  ", 20)).toBe("short");
  });

  it("cuts at a word boundary within the limit", () => {
    const result = clampText("one two three four five six seven", 15);
    expect(result.length).toBeLessThanOrEqual(15);
    expect(result).toBe("one two three");
  });

  it("cuts mid-word when there is no usable space and removes trailing punctuation", () => {
    expect(clampText("abcdefghijklmnop", 10)).toBe("abcdefghij");
    expect(clampText("alpha beta, gamma delta", 11)).toBe("alpha beta");
  });
});
