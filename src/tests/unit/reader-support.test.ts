import { describe, expect, it, vi } from "vitest";
import { requestVariant, VariantRequestError } from "@/lib/lessons/variants-client";
import {
  backTarget,
  isLastPage,
  pageOf,
  sectionRange,
  stepsToLeave,
} from "@/renderers/reader/paging";

// Five concepts in three sections: [a b] [c] [d e]
const concepts = [
  { id: "a", sectionId: "s1" },
  { id: "b", sectionId: "s1" },
  { id: "c", sectionId: "s2" },
  { id: "d", sectionId: "s3" },
  { id: "e", sectionId: "s3" },
];
const ids = (list: Array<{ id: string }>) => list.map((c) => c.id);

describe("sectionRange", () => {
  it("finds the first and last concept of the section", () => {
    expect(sectionRange(concepts, 1)).toEqual({ first: 0, last: 1 });
    expect(sectionRange(concepts, 2)).toEqual({ first: 2, last: 2 });
    expect(sectionRange(concepts, 4)).toEqual({ first: 3, last: 4 });
  });
});

describe("pageOf", () => {
  it("shows one concept, its section, or everything", () => {
    expect(ids(pageOf(concepts, 1, "concept"))).toEqual(["b"]);
    expect(ids(pageOf(concepts, 1, "section"))).toEqual(["a", "b"]);
    expect(ids(pageOf(concepts, 1, "full"))).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("shows nothing for an empty lesson or an index outside it", () => {
    expect(pageOf([], 0, "full")).toEqual([]);
    expect(pageOf(concepts, 9, "concept")).toEqual([]);
  });

  it("returns a copy in full mode, so callers cannot change the lesson", () => {
    expect(pageOf(concepts, 0, "full")).not.toBe(concepts);
  });
});

describe("stepsToLeave", () => {
  it("is one for a concept, the rest of the section, or the rest of the lesson", () => {
    expect(stepsToLeave(concepts, 0, "concept")).toBe(1);
    expect(stepsToLeave(concepts, 0, "section")).toBe(2);
    expect(stepsToLeave(concepts, 1, "section")).toBe(1);
    expect(stepsToLeave(concepts, 3, "section")).toBe(2);
    expect(stepsToLeave(concepts, 1, "full")).toBe(4);
  });

  it("is at least one", () => {
    expect(stepsToLeave([], 0, "full")).toBe(1);
  });
});

describe("isLastPage", () => {
  it("is true on the last concept or section, and always in full mode", () => {
    expect(isLastPage(concepts, 4, "concept")).toBe(true);
    expect(isLastPage(concepts, 3, "concept")).toBe(false);
    expect(isLastPage(concepts, 3, "section")).toBe(true);
    expect(isLastPage(concepts, 1, "section")).toBe(false);
    expect(isLastPage(concepts, 0, "full")).toBe(true);
  });
});

describe("backTarget", () => {
  it("goes to the previous concept, or the start of the previous section", () => {
    expect(backTarget(concepts, 2, "concept")).toBe(1);
    expect(backTarget(concepts, 4, "section")).toBe(2);
    expect(backTarget(concepts, 2, "section")).toBe(0);
    expect(backTarget(concepts, 1, "section")).toBeNull();
  });

  it("has nowhere to go from the start, and never goes back in full mode", () => {
    expect(backTarget(concepts, 0, "concept")).toBeNull();
    expect(backTarget(concepts, 3, "full")).toBeNull();
  });
});

describe("requestVariant", () => {
  const input = { lessonId: "l", conceptId: "c", readingLevel: "plain" as const };
  const reply = (body: unknown, status = 200) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("posts the request as JSON and returns the variant", async () => {
    const fetchFn = reply({ summary: "s", body: "Easy.", graphVersion: 2, cached: true });
    const result = await requestVariant(input, fetchFn);
    expect(result).toEqual({ summary: "s", body: "Easy.", graphVersion: 2, cached: true });
    const [url, init] = vi.mocked(fetchFn).mock.calls[0];
    expect(url).toBe("/api/variants");
    expect(init).toMatchObject({ method: "POST", headers: { "content-type": "application/json" } });
    expect(JSON.parse(init!.body as string)).toEqual(input);
  });

  it("uses the server's message for an error", async () => {
    const fetchFn = reply(
      { error: { code: "forbidden", message: "You cannot see this lesson." } },
      403,
    );
    await expect(requestVariant(input, fetchFn)).rejects.toMatchObject({
      message: "You cannot see this lesson.",
      status: 403,
    });
  });

  it("falls back to a plain message when the error has no body", async () => {
    const fetchFn = vi.fn(
      async () => new Response("oops", { status: 500 }),
    ) as unknown as typeof fetch;
    await expect(requestVariant(input, fetchFn)).rejects.toThrow(/could not make that simpler/);
  });

  it("explains a lost connection", async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError("network");
    }) as unknown as typeof fetch;
    await expect(requestVariant(input, fetchFn)).rejects.toThrow(/Check your connection/);
  });

  it("rejects an answer with no usable text", async () => {
    for (const body of [{}, { body: "" }, { body: "   " }, null]) {
      await expect(requestVariant(input, reply(body))).rejects.toBeInstanceOf(VariantRequestError);
    }
  });
});
