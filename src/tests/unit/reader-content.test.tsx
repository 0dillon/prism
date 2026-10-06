// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Concept } from "@/lib/schemas/knowledge-graph";
import {
  buildConceptContent,
  buildScript,
  makeUnit,
  sentenceId,
  unitsOf,
} from "@/renderers/reader/content";
import { piecesOf, RichText } from "@/renderers/reader/RichText";
import { parseInline } from "@/renderers/shared/markdown";
import { makeGraph } from "../fixtures/graph";

const concept = (over: Partial<Concept> = {}): Concept => ({
  ...makeGraph().concepts[0],
  ...over,
});

describe("buildConceptContent", () => {
  it("makes a title, then the body as paragraphs, then the key term, then examples", () => {
    const content = buildConceptContent(concept({ body: "First.\n\nSecond." }), {
      showExamples: true,
    });
    expect(content.title.text).toBe("Evaporation");
    expect(content.blocks.map((b) => (b.kind === "paragraph" ? b.tone : b.kind))).toEqual([
      "body",
      "body",
      "callout",
      "callout",
    ]);
    const callouts = content.blocks.filter((b) => b.kind === "paragraph" && b.tone === "callout");
    expect(callouts.map((b) => b.kind === "paragraph" && b.unit.text)).toEqual([
      "evaporation: Liquid water changing into vapor.",
      "For example: A puddle that dries on a sunny day.",
    ]);
  });

  it("leaves out examples when the learner has turned them off, but keeps the key term", () => {
    const content = buildConceptContent(concept(), { showExamples: false });
    const texts = unitsOf(content).map((u) => u.text);
    expect(texts.some((t) => t.startsWith("For example"))).toBe(false);
    expect(texts.some((t) => t.startsWith("evaporation:"))).toBe(true);
  });

  it("shows every example, not only the first", () => {
    const content = buildConceptContent(concept({ examples: ["One.", "Two.", "Three."] }), {
      showExamples: true,
    });
    expect(unitsOf(content).filter((u) => u.text.startsWith("For example")).length).toBe(3);
  });

  it("uses a variant body in place of the concept's own", () => {
    const content = buildConceptContent(concept(), {
      showExamples: false,
      variantBody: "Easy words.",
    });
    expect(unitsOf(content).map((u) => u.text)).toContain("Easy words.");
    expect(
      unitsOf(content)
        .map((u) => u.text)
        .join(" "),
    ).not.toContain("The sun warms water");
  });

  it("falls back to the summary when the body is empty", () => {
    const content = buildConceptContent(concept({ body: "  ", examples: [], keyTerm: undefined }), {
      showExamples: true,
    });
    expect(unitsOf(content).map((u) => u.text)).toContain(concept().summary);
  });

  it("omits the key term callout when there is no definition", () => {
    const content = buildConceptContent(concept({ definition: undefined, examples: [] }), {
      showExamples: true,
    });
    expect(content.blocks.some((b) => b.kind === "paragraph" && b.tone === "callout")).toBe(false);
  });

  it("keeps lists as lists, with each item its own unit", () => {
    const content = buildConceptContent(
      concept({
        body: "Steps:\n\n- heat the water\n- watch it rise",
        examples: [],
        keyTerm: undefined,
      }),
      { showExamples: false },
    );
    const list = content.blocks.find((b) => b.kind === "list");
    expect(list?.kind === "list" && list.items.map((i) => i.text)).toEqual([
      "heat the water",
      "watch it rise",
    ]);
  });

  it("gives every unit a distinct key", () => {
    const content = buildConceptContent(
      concept({ body: "A.\n\n- b\n- c\n\nD.", examples: ["e1", "e2"] }),
      { showExamples: true },
    );
    const keys = unitsOf(content).map((u) => u.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("reads a title as one sentence, however it is punctuated", () => {
    const content = buildConceptContent(concept({ title: "Why? How. Where!" }), {
      showExamples: false,
    });
    expect(content.title.sentences).toHaveLength(1);
  });
});

describe("buildScript", () => {
  it("lists every sentence in the order it is shown, with matching ids", () => {
    const content = buildConceptContent(
      concept({ body: "One. Two.", definition: undefined, examples: [] }),
      { showExamples: false },
    );
    expect(buildScript([content])).toEqual([
      { id: sentenceId(`${content.concept.id}/title`, 0), text: "Evaporation" },
      { id: sentenceId(`${content.concept.id}/b0`, 0), text: "One." },
      { id: sentenceId(`${content.concept.id}/b0`, 1), text: "Two." },
    ]);
  });

  it("joins concepts in order and has unique ids across them", () => {
    const graph = makeGraph();
    const contents = graph.concepts.map((c) => buildConceptContent(c, { showExamples: true }));
    const script = buildScript(contents);
    expect(new Set(script.map((s) => s.id)).size).toBe(script.length);
    expect(script[0].text).toBe("Evaporation");
    expect(script.findIndex((s) => s.text === "Condensation")).toBeGreaterThan(0);
  });

  it("reads the text, not Markdown marks", () => {
    const content = buildConceptContent(concept({ body: "The **sun** warms _water_." }), {
      showExamples: false,
    });
    expect(buildScript([content]).map((s) => s.text)).toContain("The sun warms water.");
  });

  it("is empty for no concepts", () => {
    expect(buildScript([])).toEqual([]);
  });
});

describe("piecesOf", () => {
  const joined = (text: string) => {
    const unit = makeUnit("u", parseInline(text));
    return piecesOf(unit)
      .map((p) => p.text)
      .join("");
  };

  it("never loses or adds a character", () => {
    for (const text of [
      "One. Two. Three.",
      "The **sun** warms _water_. It `rises`!",
      "  Leading space. Trailing.  ",
      "No full stop",
      "A **bold sentence. Across** two.",
      "",
    ]) {
      expect(joined(text)).toBe(makeUnit("u", parseInline(text)).text);
    }
  });

  it("splits a bold span that runs across two sentences at the boundary", () => {
    const unit = makeUnit("u", parseInline("A **bold one. And two** end."));
    const bold = piecesOf(unit).filter((p) => p.style === "strong");
    // The bold run is cut into the first sentence's part, the space between, and the second's.
    expect(bold.map((p) => p.sentence)).toEqual([0, null, 1]);
  });

  it("marks the space between sentences as belonging to none", () => {
    const unit = makeUnit("u", parseInline("One. Two."));
    expect(
      piecesOf(unit)
        .filter((p) => p.sentence === null)
        .map((p) => p.text),
    ).toEqual([" "]);
  });
});

describe("RichText", () => {
  const unit = makeUnit("u", parseInline("The **sun** warms the water. Then it rises."));

  it("shows exactly the text, with or without sentence marks and anchors", () => {
    for (const markSentences of [false, true]) {
      for (const anchors of [false, true]) {
        const { container } = render(
          <p>
            <RichText unit={unit} anchors={anchors} markSentences={markSentences} />
          </p>,
        );
        expect(container.textContent).toBe(unit.text);
      }
    }
  });

  it("keeps bold in place", () => {
    const { container } = render(
      <p>
        <RichText unit={unit} anchors={false} markSentences />
      </p>,
    );
    expect(container.querySelector("strong")?.textContent).toBe("sun");
  });

  it("wraps each sentence in a span with its id", () => {
    const { container } = render(
      <p>
        <RichText unit={unit} anchors={false} markSentences />
      </p>,
    );
    expect(
      [...container.querySelectorAll("[data-sentence]")].map((s) =>
        s.getAttribute("data-sentence"),
      ),
    ).toEqual(["u#0", "u#1"]);
  });

  it("adds no wrappers when sentences are not marked", () => {
    const { container } = render(
      <p>
        <RichText unit={unit} anchors={false} markSentences={false} />
      </p>,
    );
    expect(container.querySelector("[data-sentence]")).toBeNull();
  });

  it("marks only the active sentence", () => {
    const { container } = render(
      <p>
        <RichText unit={unit} anchors={false} markSentences activeSentenceId="u#1" />
      </p>,
    );
    const active = [...container.querySelectorAll('[data-active="true"]')];
    expect(active).toHaveLength(1);
    expect(active[0].textContent).toBe("Then it rises.");
  });

  it("marks nothing when no sentence is active", () => {
    const { container } = render(
      <p>
        <RichText unit={unit} anchors={false} markSentences activeSentenceId={null} />
      </p>,
    );
    expect(container.querySelector("[data-active]")).toBeNull();
  });

  it("applies word anchors inside bold and sentence spans", () => {
    const { container } = render(
      <p>
        <RichText unit={unit} anchors markSentences />
      </p>,
    );
    expect(container.querySelectorAll("b").length).toBeGreaterThan(5);
    expect(container.querySelector("strong b")?.textContent).toBe("su");
  });

  it("renders a unit with no text without error", () => {
    const empty = makeUnit("e", []);
    const { container } = render(
      <p>
        <RichText unit={empty} anchors markSentences />
      </p>,
    );
    expect(container.textContent).toBe("");
  });
});
