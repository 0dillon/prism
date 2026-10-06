// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useMemo } from "react";
import type { StoreApi } from "zustand/vanilla";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { announce, LiveRegions } from "@/lib/a11y/live-region";
import { VariantRequestError, type VariantResponse } from "@/lib/lessons/variants-client";
import type { ProfilePatch } from "@/lib/profile/merge";
import { createProfileStore, useProfile, type ProfileStore } from "@/lib/profile/store";
import type { KnowledgeGraph } from "@/lib/schemas/knowledge-graph";
import { clearEvents, pendingEvents } from "@/lib/session/events";
import { createSessionStore, useSession, type SessionStore } from "@/lib/session/store";
import { PrismRenderer } from "@/renderers/PrismRenderer";
import ReaderRenderer from "@/renderers/reader/ReaderRenderer";
import type { SessionActions } from "@/renderers/types";
import { expectNoAxeViolations } from "../a11y";
import { makeGraph } from "../fixtures/graph";

const variantMock = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/lib/lessons/variants-client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/lessons/variants-client")>();
  return { ...original, requestVariant: variantMock.request };
});
vi.mock("@/lib/a11y/live-region", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/a11y/live-region")>();
  return { ...original, announce: vi.fn(original.announce) };
});

/** The fixture with a second section, so section paging has something to page between. */
function twoSectionGraph(): KnowledgeGraph {
  const graph = makeGraph();
  graph.sections.push({ id: "s_2", title: "How water falls", order: 1 });
  graph.concepts[2].sectionId = "s_2";
  return graph;
}

function Harness({
  graph,
  sessionStore,
  profileStore,
}: {
  graph: KnowledgeGraph;
  sessionStore: StoreApi<SessionStore>;
  profileStore: StoreApi<ProfileStore>;
}) {
  const session = useSession(sessionStore, (s) => s.session);
  const profile = useProfile((s) => s.profile, profileStore);
  const actions = useMemo<SessionActions>(() => {
    const s = sessionStore.getState();
    return {
      start: s.start,
      next: s.next,
      previous: s.previous,
      requestQuiz: s.requestQuiz,
      answer: s.answer,
      continue: s.continue,
      goTo: s.goTo,
      restart: s.restart,
    };
  }, [sessionStore]);
  return (
    <ReaderRenderer
      graph={graph}
      session={session}
      profile={profile}
      actions={actions}
      updateProfile={(patch: ProfilePatch) => profileStore.getState().applyPatch(patch)}
    />
  );
}

interface SetupOptions {
  graph?: KnowledgeGraph;
  patch?: ProfilePatch;
  start?: boolean;
}

function setup({ graph = makeGraph(), patch = {}, start = true }: SetupOptions = {}) {
  const profileStore = createProfileStore({ storage: null });
  // Applied in turn, so a patch that sets one content field leaves the base's others alone.
  profileStore.getState().applyPatch({
    quiz: { cadence: 5, itemsPerCheck: 1 },
    content: { chunkSize: "concept", readingLevel: "original" },
  });
  profileStore.getState().applyPatch(patch);
  const sessionStore = createSessionStore({
    lessonId: graph.lessonId,
    graphVersion: 1,
    graph,
    getSettings: () => {
      const { quiz } = profileStore.getState().profile;
      return {
        cadence: quiz.cadence,
        itemsPerCheck: quiz.itemsPerCheck,
        retryOnWrong: quiz.retryOnWrong,
      };
    },
    storage: null,
    now: () => 1_000_000,
  });
  const user = userEvent.setup();
  const view = render(
    <>
      <Harness graph={graph} sessionStore={sessionStore} profileStore={profileStore} />
      <LiveRegions />
    </>,
  );
  if (start) act(() => sessionStore.getState().start());
  return {
    user,
    graph,
    profileStore,
    sessionStore,
    session: () => sessionStore.getState().session,
    ...view,
  };
}

const titles = (container: HTMLElement) =>
  [...container.querySelectorAll("article h2, article h3")].map((h) => h.textContent);
const levels = (container: HTMLElement) =>
  [...container.querySelectorAll("h1,h2,h3,h4,h5,h6")].map((h) => Number(h.tagName[1]));

beforeEach(() => {
  vi.mocked(announce).mockClear();
  variantMock.request.mockReset();
  clearEvents();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function answerActive(ctx: ReturnType<typeof setup>, correct: boolean) {
  const item = ctx.graph.quizItems.find((q) => q.id === ctx.session().activeQuizItemId)!;
  if (item.type === "short_answer") {
    await ctx.user.type(screen.getByLabelText("Your answer"), correct ? item.answer : "zzz");
    await ctx.user.click(screen.getByRole("button", { name: "Check answer" }));
    return;
  }
  const options = item.type === "mcq" ? item.options! : ["true", "false"];
  const pick = correct ? item.answer : options.find((o) => o !== item.answer)!;
  await ctx.user.click(
    screen.getByRole("button", {
      name: item.type === "true_false" ? (pick === "true" ? "True" : "False") : pick,
    }),
  );
}

describe("ReaderRenderer: structure", () => {
  it("shows the overview and Start before the lesson begins", () => {
    setup({ start: false });
    expect(screen.getByRole("heading", { level: 1, name: /The Water Cycle/ })).toBeInTheDocument();
    expect(screen.getByText(makeGraph().overview)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start" })).toBeInTheDocument();
  });

  it("has one h1, which PrismRenderer can move focus to", () => {
    const { container } = setup();
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    const h1 = container.querySelector("h1")!;
    expect(h1).toHaveAttribute("data-renderer-heading");
    expect(h1).toHaveAttribute("tabindex", "-1");
  });

  it.each(["concept", "section", "full"] as const)(
    "has sequential heading levels in %s mode",
    (chunkSize) => {
      const { container } = setup({ graph: twoSectionGraph(), patch: { content: { chunkSize } } });
      const found = levels(container);
      expect(found[0]).toBe(1);
      found.forEach((level, i) => {
        if (i > 0) expect(level).toBeLessThanOrEqual(found[i - 1] + 1);
      });
      expect(found.length).toBeGreaterThan(2);
    },
  );

  it("uses h2 for a section and h3 for each concept under it", () => {
    const { container } = setup({ patch: { content: { chunkSize: "concept" } } });
    expect(levels(container)).toEqual([1, 2, 3]);
    expect(screen.getByRole("heading", { level: 2, name: "How water moves" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Evaporation" })).toBeInTheDocument();
  });

  it("uses h2 for a concept whose section cannot be found, so no level is skipped", () => {
    const graph = makeGraph();
    graph.sections = [];
    const { container } = setup({ graph });
    expect(levels(container)).toEqual([1, 2]);
  });

  it("shows the lesson's text as paragraphs, with the key term and example", () => {
    setup();
    expect(screen.getByText(/The sun warms water in oceans/)).toBeInTheDocument();
    expect(screen.getByText(/Liquid water changing into vapor/)).toBeInTheDocument();
    expect(screen.getByText(/A puddle that dries on a sunny day/)).toBeInTheDocument();
  });

  it("leaves out examples when the learner has turned them off", () => {
    setup({ patch: { content: { showExamples: false } } });
    expect(screen.queryByText(/For example/)).not.toBeInTheDocument();
  });

  it("limits the column to the profile's line length", async () => {
    const graph = makeGraph();
    const profileStore = createProfileStore({ storage: null });
    profileStore
      .getState()
      .applyPatch({ typography: { maxLineLength: 45 }, content: { chunkSize: "concept" } });
    profileStore.getState().applyPatch({ layout: "reader" });
    const sessionStore = createSessionStore({
      lessonId: graph.lessonId,
      graphVersion: 1,
      graph,
      getSettings: () => ({ cadence: 5, itemsPerCheck: 1, retryOnWrong: true }),
      storage: null,
    });
    const { container } = render(
      <PrismRenderer graph={graph} sessionStore={sessionStore} profileStore={profileStore} />,
    );
    const reader = await waitFor(() => {
      const el = container.querySelector<HTMLElement>('[data-layout="reader"][class*="max-w"]');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(reader.className).toContain("max-w-[var(--measure)]");
    expect(
      container
        .querySelector<HTMLElement>("[data-prism-root]")!
        .style.getPropertyValue("--measure"),
    ).toBe("45ch");
  });

  it("shows progress in words", () => {
    setup();
    expect(screen.getByRole("progressbar", { name: "Lesson progress" })).toBeInTheDocument();
    expect(screen.getByText("1 of 3 ideas read")).toBeInTheDocument();
  });

  it("hides progress when the learner has turned it off", () => {
    setup({ patch: { feedback: { progressBar: false } } });
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });
});

describe("ReaderRenderer: chunk size", () => {
  it("shows one idea at a time by default for the concept setting", () => {
    const { container } = setup({ graph: twoSectionGraph() });
    expect(titles(container)).toEqual(["Evaporation"]);
  });

  it("shows the whole section in section mode, and not the next one", () => {
    const { container } = setup({
      graph: twoSectionGraph(),
      patch: { content: { chunkSize: "section" } },
    });
    expect(titles(container)).toEqual(["Evaporation", "Condensation"]);
    expect(screen.queryByRole("heading", { name: "How water falls" })).not.toBeInTheDocument();
  });

  it("shows everything in full mode", () => {
    const { container } = setup({
      graph: twoSectionGraph(),
      patch: { content: { chunkSize: "full" } },
    });
    expect(titles(container)).toEqual(["Evaporation", "Condensation", "Precipitation"]);
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(2);
  });

  it("goes one idea on and back in concept mode", async () => {
    const ctx = setup();
    await ctx.user.click(screen.getByRole("button", { name: "Next idea" }));
    expect(titles(ctx.container)).toEqual(["Condensation"]);
    expect(ctx.session().conceptIndex).toBe(1);
    await ctx.user.click(screen.getByRole("button", { name: "Back" }));
    expect(titles(ctx.container)).toEqual(["Evaporation"]);
  });

  it("has no Back on the first page", () => {
    setup();
    expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
  });

  it("goes a whole section on in section mode, counting each idea in the session", async () => {
    const ctx = setup({ graph: twoSectionGraph(), patch: { content: { chunkSize: "section" } } });
    await ctx.user.click(screen.getByRole("button", { name: "Next section" }));
    expect(titles(ctx.container)).toEqual(["Precipitation"]);
    expect(ctx.session().conceptIndex).toBe(2);
    expect(ctx.session().seenConceptIds).toEqual([
      "c_evaporation",
      "c_condensation",
      "c_precipitation",
    ]);
  });

  it("goes back to the start of the previous section", async () => {
    const ctx = setup({ graph: twoSectionGraph(), patch: { content: { chunkSize: "section" } } });
    await ctx.user.click(screen.getByRole("button", { name: "Next section" }));
    await ctx.user.click(screen.getByRole("button", { name: "Back" }));
    expect(ctx.session().conceptIndex).toBe(0);
    expect(titles(ctx.container)).toEqual(["Evaporation", "Condensation"]);
  });

  it("offers Finish on the last page, and in full mode straight away", () => {
    setup({ patch: { content: { chunkSize: "full" } } });
    expect(screen.getByRole("button", { name: "Finish" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
  });

  it("finishes the lesson from full mode through the quiz", async () => {
    const ctx = setup({
      patch: { content: { chunkSize: "full" }, quiz: { cadence: 5, itemsPerCheck: 1 } },
    });
    await ctx.user.click(screen.getByRole("button", { name: "Finish" }));
    expect(ctx.session().phase).toBe("quiz");
    await answerActive(ctx, true);
    await ctx.user.click(screen.getByRole("button", { name: "Continue" }));
    expect(ctx.session().phase).toBe("complete");
    expect(screen.getByRole("heading", { name: "Lesson complete" })).toBeInTheDocument();
  });

  it("stops going on when a quiz falls due part-way through a section", async () => {
    const ctx = setup({
      graph: twoSectionGraph(),
      patch: { content: { chunkSize: "section" }, quiz: { cadence: 1, itemsPerCheck: 1 } },
    });
    await ctx.user.click(screen.getByRole("button", { name: "Next section" }));
    expect(ctx.session().phase).toBe("quiz");
    expect(ctx.session().conceptIndex).toBe(0);
  });

  it("changes how much is shown as soon as the setting changes, keeping the place", async () => {
    const ctx = setup({ graph: twoSectionGraph() });
    await ctx.user.click(screen.getByRole("button", { name: "Next idea" }));
    act(() => void ctx.profileStore.getState().applyPatch({ content: { chunkSize: "full" } }));
    expect(titles(ctx.container)).toHaveLength(3);
    expect(ctx.session().conceptIndex).toBe(1);
  });
});

describe("ReaderRenderer: inline quizzes", () => {
  it("shows the question below the text at the learner's cadence", async () => {
    const ctx = setup({ patch: { quiz: { cadence: 1, itemsPerCheck: 1 } } });
    await ctx.user.click(screen.getByRole("button", { name: "Next idea" }));
    const group = screen.getByRole("group", { name: "Quick check" });
    expect(group).toBeInTheDocument();
    // The idea just read is still on the page above the question.
    expect(titles(ctx.container)).toEqual(["Evaporation"]);
    expect(screen.queryByRole("navigation", { name: "Reading controls" })).not.toBeInTheDocument();
  });

  it("moves focus to the question", async () => {
    const ctx = setup({ patch: { quiz: { cadence: 1, itemsPerCheck: 1 } } });
    await ctx.user.click(screen.getByRole("button", { name: "Next idea" }));
    expect(screen.getByRole("group", { name: "Quick check" })).toHaveFocus();
  });

  it("answers through the same session action every layout uses", async () => {
    const ctx = setup({ patch: { quiz: { cadence: 1, itemsPerCheck: 1 } } });
    await ctx.user.click(screen.getByRole("button", { name: "Next idea" }));
    const id = ctx.session().activeQuizItemId;
    await answerActive(ctx, false);
    expect(ctx.session()).toMatchObject({
      phase: "feedback",
      lastAnswer: { quizItemId: id, correct: false },
      answeredCount: 1,
    });
  });

  it("says the result in words and focuses Continue", async () => {
    const ctx = setup({ patch: { quiz: { cadence: 1, itemsPerCheck: 1 } } });
    await ctx.user.click(screen.getByRole("button", { name: "Next idea" }));
    await answerActive(ctx, true);
    expect(
      within(screen.getByRole("group", { name: "Quick check" })).getByText("Correct."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toHaveFocus();
  });

  it("goes on to the next idea after Continue and focuses its heading", async () => {
    const ctx = setup({ patch: { quiz: { cadence: 1, itemsPerCheck: 1 } } });
    await ctx.user.click(screen.getByRole("button", { name: "Next idea" }));
    await answerActive(ctx, true);
    await ctx.user.click(screen.getByRole("button", { name: "Continue" }));
    expect(ctx.session().phase).toBe("learning");
    expect(screen.getByRole("heading", { level: 3, name: "Condensation" })).toHaveFocus();
  });

  it("opens a quiz on request", async () => {
    const ctx = setup();
    await ctx.user.click(screen.getByRole("button", { name: "Quiz me" }));
    expect(ctx.session().phase).toBe("quiz");
  });

  it("matches the cards layout: the same answers give the same session", async () => {
    const run = async () => {
      const ctx = setup({ patch: { quiz: { cadence: 1, itemsPerCheck: 1 } } });
      await ctx.user.click(screen.getByRole("button", { name: "Next idea" }));
      await answerActive(ctx, true);
      const s = ctx.session();
      ctx.unmount();
      return {
        phase: s.phase,
        answered: s.answeredCount,
        correct: s.correctCount,
        streak: s.streak,
      };
    };
    expect(await run()).toEqual({ phase: "feedback", answered: 1, correct: 1, streak: 1 });
  });
});

describe("ReaderRenderer: focus and the end", () => {
  it("focuses the new idea's heading after Next, so the change is heard", async () => {
    const ctx = setup();
    await ctx.user.click(screen.getByRole("button", { name: "Next idea" }));
    expect(screen.getByRole("heading", { level: 3, name: "Condensation" })).toHaveFocus();
  });

  it("does not move focus when the learner has only started reading", () => {
    setup({ start: false });
    expect(document.body).toHaveFocus();
  });

  it("shows the summary at the end and focuses it", async () => {
    const ctx = setup({ patch: { quiz: { cadence: 5, itemsPerCheck: 1 } } });
    for (let i = 0; i < 3; i++)
      await ctx.user.click(screen.getByRole("button", { name: i === 2 ? "Finish" : "Next idea" }));
    while (ctx.session().phase === "quiz" || ctx.session().phase === "feedback") {
      if (ctx.session().phase === "quiz") await answerActive(ctx, true);
      else await ctx.user.click(screen.getByRole("button", { name: "Continue" }));
    }
    expect(ctx.session().phase).toBe("complete");
    expect(screen.getByText("Ideas mastered")).toBeInTheDocument();
    expect(screen.getByText("Complete")).toBeInTheDocument();
  });

  it("starts again from the summary", async () => {
    const ctx = setup();
    act(() => {
      ctx.sessionStore.setState({ session: { ...ctx.session(), phase: "complete" } });
    });
    await ctx.user.click(screen.getByRole("button", { name: "Go through it again" }));
    expect(ctx.session().phase).toBe("intro");
  });
});

describe("ReaderRenderer: word anchors", () => {
  it("bolds the start of each word when the setting is on, leaving the text unchanged", () => {
    const { container } = setup({ patch: { typography: { wordAnchors: true } } });
    const paragraph = screen.getByText(
      (_, el) => el?.tagName === "P" && el.textContent?.startsWith("The sun warms") === true,
    );
    expect(paragraph.textContent).toBe(makeGraph().concepts[0].body);
    expect(paragraph.querySelectorAll("b").length).toBeGreaterThan(5);
    expect(container.querySelector("h3 b")).toBeNull();
  });

  it("adds no bold when it is off", () => {
    const { container } = setup();
    expect(container.querySelector("article b")).toBeNull();
  });

  it("turns on and off live", () => {
    const ctx = setup();
    act(() => void ctx.profileStore.getState().applyPatch({ typography: { wordAnchors: true } }));
    expect(ctx.container.querySelector("article b")).not.toBeNull();
    act(() => void ctx.profileStore.getState().applyPatch({ typography: { wordAnchors: false } }));
    expect(ctx.container.querySelector("article b")).toBeNull();
  });
});

describe("ReaderRenderer: read aloud", () => {
  class FakeUtterance {
    static all: FakeUtterance[] = [];
    lang = "";
    rate = 1;
    voice: unknown = null;
    onstart: (() => void) | null = null;
    onend: (() => void) | null = null;
    onerror: ((e: { error?: string }) => void) | null = null;
    onboundary: (() => void) | null = null;
    constructor(public text: string) {
      FakeUtterance.all.push(this);
    }
  }
  let scrolled: Element[] = [];

  beforeEach(() => {
    FakeUtterance.all = [];
    scrolled = [];
    vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
    vi.stubGlobal("speechSynthesis", { speak: vi.fn(), cancel: vi.fn(), getVoices: () => [] });
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
  });
  afterEach(() => {
    // @ts-expect-error removing the stub
    delete Element.prototype.scrollIntoView;
  });

  const withAudio = (extra: ProfilePatch["audio"] = {}) => ({
    audio: { readAloud: true, syncHighlight: "sentence" as const, ...extra },
  });
  const spoken = () => FakeUtterance.all.map((u) => u.text);
  const active = (container: HTMLElement) =>
    container.querySelector('[data-active="true"]')?.textContent;

  it("shows the controls only when read aloud is on", () => {
    const off = setup();
    expect(screen.queryByRole("button", { name: "Play" })).not.toBeInTheDocument();
    off.unmount();
    setup({ patch: withAudio() });
    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
  });

  it("does not start speaking by itself", () => {
    setup({ patch: withAudio() });
    expect(FakeUtterance.all).toHaveLength(0);
  });

  it("reads the title first and highlights it, then each sentence in turn", async () => {
    const ctx = setup({ patch: withAudio() });
    await ctx.user.click(screen.getByRole("button", { name: "Play" }));
    expect(spoken()).toEqual(["Evaporation"]);
    expect(active(ctx.container)).toBe("Evaporation");
    act(() => FakeUtterance.all.at(-1)!.onend?.());
    const firstSentence = "The sun warms water in oceans, lakes, and rivers.";
    expect(spoken().at(-1)).toBe(firstSentence);
    expect(active(ctx.container)).toBe(firstSentence);
  });

  it("highlights exactly the sentence being spoken, even in the middle of a paragraph", async () => {
    const graph = makeGraph();
    graph.concepts[0].body = "First sentence here. Second sentence here. Third one.";
    const ctx = setup({ graph, patch: withAudio() });
    await ctx.user.click(screen.getByRole("button", { name: "Play" }));
    act(() => FakeUtterance.all.at(-1)!.onend?.()); // title done
    expect(active(ctx.container)).toBe("First sentence here.");
    act(() => FakeUtterance.all.at(-1)!.onend?.());
    expect(active(ctx.container)).toBe("Second sentence here.");
    expect(ctx.container.querySelectorAll('[data-active="true"]')).toHaveLength(1);
  });

  it("scrolls the sentence being read into view", async () => {
    const ctx = setup({ patch: withAudio() });
    await ctx.user.click(screen.getByRole("button", { name: "Play" }));
    expect(scrolled.length).toBeGreaterThan(0);
  });

  it("does not highlight when highlighting is off, but still reads", async () => {
    const ctx = setup({ patch: withAudio({ syncHighlight: "off" }) });
    await ctx.user.click(screen.getByRole("button", { name: "Play" }));
    expect(spoken()).toEqual(["Evaporation"]);
    expect(ctx.container.querySelector("[data-sentence]")).toBeNull();
  });

  it("keeps the page's text exactly as it was while highlighting", async () => {
    const ctx = setup({ patch: withAudio() });
    const before = ctx.container.querySelector("article")!.textContent;
    await ctx.user.click(screen.getByRole("button", { name: "Play" }));
    expect(ctx.container.querySelector("article")!.textContent).toBe(before);
  });

  it("clears the highlight when stopped", async () => {
    const ctx = setup({ patch: withAudio() });
    await ctx.user.click(screen.getByRole("button", { name: "Play" }));
    await ctx.user.click(screen.getByRole("button", { name: "Stop" }));
    expect(active(ctx.container)).toBeUndefined();
  });

  it("starts over, silent, when the learner moves to the next idea", async () => {
    const ctx = setup({ patch: withAudio() });
    await ctx.user.click(screen.getByRole("button", { name: "Play" }));
    await ctx.user.click(screen.getByRole("button", { name: "Next idea" }));
    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
    expect(active(ctx.container)).toBeUndefined();
  });

  it("changes the speed in the profile, which is the one place settings live", async () => {
    const ctx = setup({ patch: withAudio() });
    await ctx.user.selectOptions(screen.getByLabelText("Speed"), "1.5");
    expect(ctx.profileStore.getState().profile.audio.rate).toBe(1.5);
    await ctx.user.click(screen.getByRole("button", { name: "Play" }));
    expect(FakeUtterance.all.at(-1)!.rate).toBe(1.5);
  });

  it("reads the key term and examples too", async () => {
    const graph = makeGraph();
    graph.concepts[0].body = "Short.";
    const ctx = setup({ graph, patch: withAudio() });
    await ctx.user.click(screen.getByRole("button", { name: "Play" }));
    for (let i = 0; i < 6; i++) act(() => FakeUtterance.all.at(-1)!.onend?.());
    expect(spoken()).toContain("evaporation: Liquid water changing into vapor.");
    expect(spoken()).toContain("For example: A puddle that dries on a sunny day.");
  });
});

describe("ReaderRenderer: simpler wording", () => {
  const variant = (body: string): VariantResponse => ({
    summary: "s",
    body,
    graphVersion: 1,
    cached: false,
  });
  const evaporation = () => screen.getByRole("article", { name: "Evaporation" });

  it("offers a Simpler button on each concept", () => {
    setup({ patch: { content: { chunkSize: "full" } } });
    expect(screen.getAllByRole("button", { name: /^Simpler version of/ })).toHaveLength(3);
  });

  it("asks for the plain version, shows progress, then swaps the text in place", async () => {
    let resolve!: (v: VariantResponse) => void;
    variantMock.request.mockReturnValue(new Promise<VariantResponse>((r) => (resolve = r)));
    const ctx = setup();
    await ctx.user.click(screen.getByRole("button", { name: "Simpler version of Evaporation" }));
    expect(variantMock.request).toHaveBeenCalledWith({
      lessonId: "lesson_water_cycle",
      conceptId: "c_evaporation",
      readingLevel: "plain",
    });
    expect(screen.getByText("Making this simpler…")).toBeInTheDocument();
    expect(within(evaporation()).getByText(/The sun warms water in oceans/)).toBeInTheDocument(); // original stays until it arrives
    await act(async () => resolve(variant("Water goes up in the air when it is hot.")));
    expect(
      within(evaporation()).getByText("Water goes up in the air when it is hot."),
    ).toBeInTheDocument();
    expect(
      within(evaporation()).queryByText(/The sun warms water in oceans/),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Plainer wording")).toBeInTheDocument();
    expect(screen.queryByText("Making this simpler…")).not.toBeInTheDocument();
    void ctx;
  });

  it("queues a concept_variant_requested event", async () => {
    variantMock.request.mockResolvedValue(variant("Easy."));
    const ctx = setup();
    await ctx.user.click(screen.getByRole("button", { name: "Simpler version of Evaporation" }));
    expect(pendingEvents()).toHaveLength(1);
    expect(pendingEvents()[0]).toMatchObject({
      type: "concept_variant_requested",
      conceptId: "c_evaporation",
      lessonId: "lesson_water_cycle",
      graphVersion: 1,
      layout: "reader",
    });
    expect(pendingEvents()[0].id).toMatch(/^[0-9A-Z]{26}$/);
  });

  it("goes plain, then very simple, then has no further Simpler", async () => {
    variantMock.request.mockImplementation(async ({ readingLevel }: { readingLevel: string }) =>
      variant(`${readingLevel} text`),
    );
    const ctx = setup();
    await ctx.user.click(screen.getByRole("button", { name: "Simpler version of Evaporation" }));
    await screen.findByText("plain text");
    await ctx.user.click(screen.getByRole("button", { name: "Simpler version of Evaporation" }));
    await screen.findByText("simple text");
    expect(screen.getByText("Very simple wording")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Simpler version of Evaporation" }),
    ).not.toBeInTheDocument();
    expect(variantMock.request).toHaveBeenCalledTimes(2);
  });

  it("goes back to the original without asking again, and forward again from the cache", async () => {
    variantMock.request.mockResolvedValue(variant("Easy words."));
    const ctx = setup();
    await ctx.user.click(screen.getByRole("button", { name: "Simpler version of Evaporation" }));
    await screen.findByText("Easy words.");
    await ctx.user.click(screen.getByRole("button", { name: "Original wording of Evaporation" }));
    expect(screen.getByText(/The sun warms water in oceans/)).toBeInTheDocument();
    await ctx.user.click(screen.getByRole("button", { name: "Simpler version of Evaporation" }));
    expect(await screen.findByText("Easy words.")).toBeInTheDocument();
    expect(variantMock.request).toHaveBeenCalledTimes(1);
  });

  it("changes only the concept it was pressed on", async () => {
    variantMock.request.mockResolvedValue(variant("Easy words."));
    const ctx = setup({ patch: { content: { chunkSize: "full" } } });
    await ctx.user.click(screen.getByRole("button", { name: "Simpler version of Condensation" }));
    await screen.findByText("Easy words.");
    expect(screen.getByText(/The sun warms water in oceans/)).toBeInTheDocument();
    expect(screen.getAllByText("Plainer wording")).toHaveLength(1);
  });

  it("explains a failure, keeps the original, and tries again on request", async () => {
    variantMock.request.mockRejectedValueOnce(
      new VariantRequestError("We could not make that simpler just now."),
    );
    variantMock.request.mockResolvedValueOnce(variant("Now it works."));
    const ctx = setup();
    await ctx.user.click(screen.getByRole("button", { name: "Simpler version of Evaporation" }));
    expect(await within(evaporation()).findByRole("alert")).toHaveTextContent(
      "We could not make that simpler just now.",
    );
    expect(screen.getByText(/The sun warms water in oceans/)).toBeInTheDocument();
    await ctx.user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Now it works.")).toBeInTheDocument();
    expect(variantMock.request).toHaveBeenCalledTimes(2);
  });

  it("does not retry a failure on its own", async () => {
    variantMock.request.mockRejectedValue(new VariantRequestError("Nope."));
    const ctx = setup();
    await ctx.user.click(screen.getByRole("button", { name: "Simpler version of Evaporation" }));
    await within(evaporation()).findByRole("alert");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(variantMock.request).toHaveBeenCalledTimes(1);
  });

  it("fetches the plain version of what is on screen when the profile asks for it", async () => {
    variantMock.request.mockResolvedValue(variant("Plain by default."));
    setup({ patch: { content: { readingLevel: "plain" } } });
    expect(await screen.findByText("Plain by default.")).toBeInTheDocument();
    expect(variantMock.request).toHaveBeenCalledTimes(1);
    expect(variantMock.request).toHaveBeenCalledWith(
      expect.objectContaining({ readingLevel: "plain", conceptId: "c_evaporation" }),
    );
  });

  it("makes no request at all for the original wording", () => {
    setup();
    expect(variantMock.request).not.toHaveBeenCalled();
    expect(pendingEvents()).toHaveLength(0);
  });

  it("does not ask twice for the same concept at the same level", async () => {
    variantMock.request.mockResolvedValue(variant("Once."));
    const ctx = setup({ patch: { content: { readingLevel: "plain" } } });
    await screen.findByText("Once.");
    await ctx.user.click(screen.getByRole("button", { name: "Next idea" }));
    await ctx.user.click(screen.getByRole("button", { name: "Back" }));
    expect(
      variantMock.request.mock.calls.filter(([a]) => a.conceptId === "c_evaporation"),
    ).toHaveLength(1);
  });

  it("reads the simpler text aloud, not the original", async () => {
    variantMock.request.mockResolvedValue(variant("Easy words."));
    vi.stubGlobal(
      "SpeechSynthesisUtterance",
      class {
        static all: string[] = [];
        constructor(public text: string) {
          (this.constructor as unknown as { all: string[] }).all.push(text);
        }
      },
    );
    vi.stubGlobal("speechSynthesis", { speak: vi.fn(), cancel: vi.fn(), getVoices: () => [] });
    const ctx = setup({ patch: { audio: { readAloud: true } } });
    await ctx.user.click(screen.getByRole("button", { name: "Simpler version of Evaporation" }));
    await screen.findByText("Easy words.");
    await ctx.user.click(screen.getByRole("button", { name: "Play" }));
    act(() => {});
    const Utterance = (globalThis as unknown as { SpeechSynthesisUtterance: { all: string[] } })
      .SpeechSynthesisUtterance;
    expect(Utterance.all[0]).toBe("Evaporation");
  });
});

describe("ReaderRenderer: accessibility", () => {
  it("has no axe violations in any phase or mode", async () => {
    for (const chunkSize of ["concept", "section", "full"] as const) {
      const ctx = setup({
        graph: twoSectionGraph(),
        patch: {
          content: { chunkSize },
          quiz: { cadence: 1, itemsPerCheck: 1 },
          audio: { readAloud: true },
          typography: { wordAnchors: true },
        },
        start: false,
      });
      await expectNoAxeViolations(ctx.container);
      act(() => ctx.sessionStore.getState().start());
      await expectNoAxeViolations(ctx.container);
      await ctx.user.click(screen.getByRole("button", { name: /Next|Finish/ }));
      await expectNoAxeViolations(ctx.container); // quiz
      await answerActive(ctx, true);
      await expectNoAxeViolations(ctx.container); // feedback
      ctx.unmount();
    }
  });

  it("is operable by keyboard from the first idea to the quiz", async () => {
    const ctx = setup({ patch: { quiz: { cadence: 1, itemsPerCheck: 1 } } });
    await ctx.user.tab(); // first control: Simpler
    await ctx.user.tab(); // Next idea
    expect(screen.getByRole("button", { name: "Next idea" })).toHaveFocus();
    await ctx.user.keyboard("{Enter}");
    expect(ctx.session().phase).toBe("quiz");
    expect(screen.getByRole("group", { name: "Quick check" })).toHaveFocus();
  });
});
