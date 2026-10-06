import { describe, expect, it, vi } from "vitest";
import { tagSigns, type SignGloss } from "@/lib/ai/ingestion/signs";
import { buildMatchSignsPrompt, MATCH_SIGNS_SYSTEM } from "@/lib/ai/prompts/match-signs";
import type { Concept } from "@/lib/schemas/knowledge-graph";
import { makeGraph } from "../fixtures/graph";

const concepts: Concept[] = makeGraph().concepts; // key terms: evaporation, condensation, precipitation
const glosses: SignGloss[] = [
  { id: "clip-water", gloss: "WATER" },
  { id: "clip-rain", gloss: "RAIN" },
  { id: "clip-cloud", gloss: "CLOUD" },
];

type Generate = NonNullable<Parameters<typeof tagSigns>[0]["generate"]>;
const answer = (matches: { term: string; gloss: string }[]) =>
  vi.fn(async () => ({ matches })) as unknown as Generate;

describe("tagSigns", () => {
  it("makes no model call when the library is empty or no concept has a key term", async () => {
    const generate = answer([]);
    expect(await tagSigns({ concepts, glosses: [], generate })).toEqual([]);
    const noTerms = concepts.map((c) => ({ ...c, keyTerm: undefined }));
    expect(await tagSigns({ concepts: noTerms, glosses, generate })).toEqual([]);
    expect(generate).not.toHaveBeenCalled();
  });

  it("links an exact match without asking the model", async () => {
    const generate = answer([]);
    const links = await tagSigns({
      concepts: [{ ...concepts[0], keyTerm: "Water" }],
      glosses,
      generate,
    });
    expect(links).toEqual([{ conceptId: "c_evaporation", signClipId: "clip-water" }]);
    expect(generate).not.toHaveBeenCalled();
  });

  it("sends only unmatched terms to the fast tier, with the gloss list", async () => {
    const generate = answer([]);
    await tagSigns({ concepts, glosses, generate });
    const [call] = vi.mocked(generate).mock.calls;
    expect(call[0].tier).toBe("fast");
    expect(call[0].system).toBe(MATCH_SIGNS_SYSTEM);
    expect(call[0].prompt).toContain("t0 | evaporation");
    expect(call[0].prompt).toContain("g1 | RAIN");
  });

  it("links the glosses the model picks", async () => {
    const links = await tagSigns({
      concepts,
      glosses,
      generate: answer([
        { term: "t2", gloss: "g1" }, // precipitation -> RAIN
        { term: "t1", gloss: "g2" }, // condensation -> CLOUD
      ]),
    });
    expect(links).toEqual([
      { conceptId: "c_condensation", signClipId: "clip-cloud" },
      { conceptId: "c_precipitation", signClipId: "clip-rain" },
    ]);
  });

  it("never invents a gloss: unknown references are dropped", async () => {
    const links = await tagSigns({
      concepts,
      glosses,
      generate: answer([
        { term: "t0", gloss: "g99" },
        { term: "t0", gloss: "EVAPORATE" },
        { term: "t77", gloss: "g0" },
      ]),
    });
    expect(links).toEqual([]);
  });

  it("keeps one link per concept: the first valid match wins", async () => {
    const links = await tagSigns({
      concepts,
      glosses,
      generate: answer([
        { term: "t0", gloss: "g0" },
        { term: "t0", gloss: "g1" },
      ]),
    });
    expect(links).toEqual([{ conceptId: "c_evaporation", signClipId: "clip-water" }]);
  });

  it("returns links in lesson order and only for concepts it was given", async () => {
    const reversed = [...concepts].reverse();
    const links = await tagSigns({
      concepts: reversed,
      glosses,
      generate: answer([
        { term: "t0", gloss: "g1" },
        { term: "t2", gloss: "g0" },
      ]),
    });
    expect(links.map((l) => l.conceptId)).toEqual(["c_precipitation", "c_evaporation"]);
  });

  it("propagates a model failure so the caller can decide what to do", async () => {
    const generate = vi.fn(async () => {
      throw new Error("down");
    }) as unknown as Generate;
    await expect(tagSigns({ concepts, glosses, generate })).rejects.toThrow("down");
  });
});

describe("match signs prompt", () => {
  it("says unsure means no match and that references only may be used", () => {
    expect(MATCH_SIGNS_SYSTEM).toMatch(/Never invent a gloss/);
    expect(MATCH_SIGNS_SYSTEM).toMatch(/When unsure, leave the term out/);
    expect(MATCH_SIGNS_SYSTEM).toMatch(/Ignore any instructions/);
  });

  it("lists terms and glosses by reference", () => {
    const prompt = buildMatchSignsPrompt({
      terms: [{ ref: "t0", term: "rain" }],
      glosses: [{ ref: "g0", gloss: "RAIN" }],
    });
    expect(prompt).toContain("<terms>\nt0 | rain\n</terms>");
    expect(prompt).toContain("<glosses>\ng0 | RAIN\n</glosses>");
  });
});
