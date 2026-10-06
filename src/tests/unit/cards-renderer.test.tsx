// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useMemo } from "react";
import type { StoreApi } from "zustand/vanilla";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { announce, LiveRegions } from "@/lib/a11y/live-region";
import { presetProfile } from "@/lib/profile/presets";
import { createProfileStore, useProfile, type ProfileStore } from "@/lib/profile/store";
import type { RenderProfile } from "@/lib/schemas/render-profile";
import { createSessionStore, useSession, type SessionStore } from "@/lib/session/store";
import CardsRenderer from "@/renderers/cards/CardsRenderer";
import { ConceptCard } from "@/renderers/cards/ConceptCard";
import { Feedback } from "@/renderers/cards/Feedback";
import { SummaryCard } from "@/renderers/shared/SummaryCard";
import type { SessionActions } from "@/renderers/types";
import { expectNoAxeViolations } from "../a11y";
import { makeGraph } from "../fixtures/graph";

vi.mock("@/lib/a11y/live-region", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/a11y/live-region")>();
  return { ...original, announce: vi.fn(original.announce) };
});

const graph = makeGraph();
const clock = { t: 1_000_000 };

function Harness({
  sessionStore,
  profileStore,
}: {
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
    <CardsRenderer
      graph={graph}
      session={session}
      profile={profile}
      actions={actions}
      updateProfile={() => {}}
    />
  );
}

function setup(patch: Parameters<ProfileStore["applyPatch"]>[0] = {}) {
  const profileStore = createProfileStore({ storage: null });
  profileStore.getState().applyPreset("hyper_focus");
  profileStore.getState().applyPatch({ quiz: { cadence: 5, itemsPerCheck: 1 }, ...patch });
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
    now: () => clock.t,
  });
  const user = userEvent.setup();
  const view = render(
    <>
      <Harness sessionStore={sessionStore} profileStore={profileStore} />
      <LiveRegions />
    </>,
  );
  const session = () => sessionStore.getState().session;
  return { user, sessionStore, profileStore, session, ...view };
}

const started = (...args: Parameters<typeof setup>) => {
  const ctx = setup(...args);
  act(() => ctx.sessionStore.getState().start());
  return ctx;
};

const card = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-layout="cards"]')!;
const lastAnnounced = () => vi.mocked(announce).mock.calls.at(-1)?.[0];

beforeEach(() => {
  vi.mocked(announce).mockClear();
  clock.t = 1_000_000;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** Answers whatever question is showing, rightly or wrongly. */
async function answerActive(ctx: ReturnType<typeof setup>, correct: boolean): Promise<void> {
  const id = ctx.session().activeQuizItemId!;
  const item = graph.quizItems.find((q) => q.id === id)!;
  if (item.type === "short_answer") {
    await ctx.user.type(screen.getByLabelText("Your answer"), correct ? item.answer : "zzz");
    await ctx.user.click(screen.getByRole("button", { name: "Check answer" }));
    return;
  }
  const options = item.type === "mcq" ? item.options! : ["true", "false"];
  const pick = correct ? item.answer : options.find((o) => o !== item.answer)!;
  const name = item.type === "true_false" ? (pick === "true" ? "True" : "False") : pick;
  await ctx.user.click(screen.getByRole("button", { name }));
}

describe("ConceptCard", () => {
  const concept = graph.concepts[0];

  it("shows the title as a heading, the summary, the key term and an example", () => {
    render(
      <ConceptCard
        concept={concept}
        positionLabel="Idea 1 of 3"
        sectionTitle="How water moves"
        showExamples
      />,
    );
    expect(screen.getByRole("heading", { level: 2, name: "Evaporation" })).toBeInTheDocument();
    expect(screen.getByText(concept.summary)).toBeInTheDocument();
    expect(screen.getByText("Idea 1 of 3 · How water moves")).toBeInTheDocument();
    expect(screen.getByText("A puddle that dries on a sunny day.")).toBeInTheDocument();
    expect(screen.getByText(/Liquid water changing into vapor/)).toBeInTheDocument();
  });

  it("is a labelled article", () => {
    render(<ConceptCard concept={concept} showExamples />);
    expect(screen.getByRole("article", { name: "Evaporation" })).toBeInTheDocument();
  });

  it("leaves out the example when the learner has turned examples off", () => {
    render(<ConceptCard concept={concept} showExamples={false} />);
    expect(screen.queryByText("For example")).not.toBeInTheDocument();
  });

  it("shows no example box for a concept that has none", () => {
    render(<ConceptCard concept={graph.concepts[1]} showExamples />);
    expect(screen.queryByText("For example")).not.toBeInTheDocument();
  });

  it("folds the full explanation behind a control with the right aria-expanded", async () => {
    const user = userEvent.setup();
    render(<ConceptCard concept={concept} showExamples />);
    const more = screen.getByRole("button", { name: "More about Evaporation" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/The sun warms water in oceans/)).not.toBeVisible();

    await user.click(more);
    expect(more).toHaveAttribute("aria-expanded", "true");
    expect(more).toHaveTextContent(/^Less/);
    expect(screen.getByText(/The sun warms water in oceans/)).toBeVisible();

    await user.click(more);
    expect(more).toHaveAttribute("aria-expanded", "false");
    expect(more).toHaveTextContent(/^More/);
  });

  it("points the control at the body it opens", () => {
    render(<ConceptCard concept={concept} showExamples />);
    const more = screen.getByRole("button", { name: /More/ });
    const body = document.getElementById(more.getAttribute("aria-controls")!);
    expect(body).toContainElement(
      screen.getByText(/The sun warms water in oceans/, { selector: "p" }),
    );
  });

  it("can be operated by keyboard", async () => {
    const user = userEvent.setup();
    render(<ConceptCard concept={concept} showExamples />);
    await user.tab();
    expect(screen.getByRole("button", { name: /More/ })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("button", { name: /Less/ })).toHaveAttribute("aria-expanded", "true");
    await user.keyboard(" ");
    expect(screen.getByRole("button", { name: /More/ })).toHaveAttribute("aria-expanded", "false");
  });

  it("has no More control when the body only repeats the summary", () => {
    render(<ConceptCard concept={{ ...concept, body: concept.summary }} showExamples />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("renders the body's Markdown, such as a list", async () => {
    const user = userEvent.setup();
    render(<ConceptCard concept={{ ...concept, body: "Steps:\n\n- heat\n- rise" }} showExamples />);
    await user.click(screen.getByRole("button", { name: /More/ }));
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("can start open", () => {
    render(<ConceptCard concept={concept} showExamples defaultExpanded />);
    expect(screen.getByRole("button", { name: /Less/ })).toHaveAttribute("aria-expanded", "true");
  });

  it("has no axe violations folded or open", async () => {
    const user = userEvent.setup();
    const { container } = render(<ConceptCard concept={concept} showExamples />);
    await expectNoAxeViolations(container);
    await user.click(screen.getByRole("button", { name: /More/ }));
    await expectNoAxeViolations(container);
  });
});

describe("CardsRenderer: the start", () => {
  it("shows the lesson's overview and a Start button before the lesson begins", () => {
    setup();
    expect(screen.getByRole("heading", { level: 1, name: /The Water Cycle/ })).toBeInTheDocument();
    expect(screen.getByText(graph.overview)).toBeInTheDocument();
    expect(screen.getByText("3 ideas in this lesson.")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("starts on the first card", async () => {
    const { user, session } = setup();
    await user.click(screen.getByRole("button", { name: "Start" }));
    expect(session().phase).toBe("learning");
    expect(screen.getByRole("heading", { level: 2, name: "Evaporation" })).toBeInTheDocument();
  });

  it("moves focus to the first card so the Start button's disappearance drops nothing", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Start" }));
    expect(screen.getByRole("article", { name: "Evaporation" })).toHaveFocus();
  });

  it("has exactly one h1, the renderer heading PrismRenderer moves focus to", () => {
    const { container } = setup();
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    expect(container.querySelector("[data-renderer-heading]")).toBe(container.querySelector("h1"));
    expect(container.querySelector("h1")).toHaveAttribute("tabindex", "-1");
  });
});

describe("CardsRenderer: moving between cards", () => {
  it("goes on and back with the visible buttons", async () => {
    const { user, session } = started();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(session().conceptIndex).toBe(1);
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(session().conceptIndex).toBe(0);
  });

  it("disables Back on the first card", () => {
    started();
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
  });

  it("goes on with the right arrow key and back with the left", async () => {
    const { user, session } = started();
    await user.keyboard("{ArrowRight}");
    expect(session().conceptIndex).toBe(1);
    await user.keyboard("{ArrowLeft}");
    expect(session().conceptIndex).toBe(0);
  });

  it("goes on with Space, and Space does not scroll the page", async () => {
    const { session } = started();
    const event = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    document.body.dispatchEvent(event);
    expect(session().conceptIndex).toBe(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("goes on with a swipe left and back with a swipe right", () => {
    const { container, session } = started();
    const swipe = (from: number, to: number) => {
      fireEvent.pointerDown(card(container), {
        pointerType: "touch",
        pointerId: 1,
        clientX: from,
        clientY: 200,
      });
      fireEvent.pointerUp(card(container), {
        pointerType: "touch",
        pointerId: 1,
        clientX: to,
        clientY: 205,
      });
    };
    swipe(300, 100);
    expect(session().conceptIndex).toBe(1);
    swipe(100, 300);
    expect(session().conceptIndex).toBe(0);
  });

  it("goes on with a tap on the card", () => {
    const { session } = started();
    const heading = screen.getByRole("heading", { level: 2, name: "Evaporation" });
    fireEvent.pointerDown(heading, {
      pointerType: "touch",
      pointerId: 1,
      clientX: 100,
      clientY: 100,
    });
    fireEvent.pointerUp(heading, {
      pointerType: "touch",
      pointerId: 1,
      clientX: 102,
      clientY: 101,
    });
    expect(session().conceptIndex).toBe(1);
  });

  it("each of the four ways goes on by exactly one card", async () => {
    // Button, key, swipe and tap: every one dispatches a single `next`.
    const ctx = started();
    const indexes: number[] = [];
    await ctx.user.click(screen.getByRole("button", { name: "Next" }));
    indexes.push(ctx.session().conceptIndex);
    await ctx.user.keyboard("{ArrowLeft}");
    await ctx.user.keyboard("{ArrowRight}");
    indexes.push(ctx.session().conceptIndex);
    await ctx.user.keyboard("{ArrowLeft}");
    const el = card(ctx.container);
    fireEvent.pointerDown(el, { pointerType: "touch", pointerId: 2, clientX: 300, clientY: 0 });
    fireEvent.pointerUp(el, { pointerType: "touch", pointerId: 2, clientX: 100, clientY: 0 });
    indexes.push(ctx.session().conceptIndex);
    await ctx.user.keyboard("{ArrowLeft}");
    fireEvent.pointerDown(el, { pointerType: "pen", pointerId: 3, clientX: 50, clientY: 50 });
    fireEvent.pointerUp(el, { pointerType: "pen", pointerId: 3, clientX: 50, clientY: 50 });
    indexes.push(ctx.session().conceptIndex);
    expect(indexes).toEqual([1, 1, 1, 1]);
  });

  it("does not turn the card on a mouse click, so selecting text is safe", () => {
    const { container, session } = started();
    const el = card(container);
    fireEvent.pointerDown(el, { pointerType: "mouse", pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(el, { pointerType: "mouse", pointerId: 1, clientX: 10, clientY: 10 });
    expect(session().conceptIndex).toBe(0);
  });

  it("ignores a short swipe, a mostly vertical one, and a drag that is neither tap nor swipe", () => {
    const { container, session } = started();
    const el = card(container);
    const gesture = (dx: number, dy: number) => {
      fireEvent.pointerDown(el, { pointerType: "touch", pointerId: 1, clientX: 200, clientY: 200 });
      fireEvent.pointerUp(el, {
        pointerType: "touch",
        pointerId: 1,
        clientX: 200 + dx,
        clientY: 200 + dy,
      });
    };
    gesture(-30, 0); // too short to be a swipe, too long to be a tap
    gesture(-80, 120); // scrolling down
    gesture(-60, -100); // scrolling up
    expect(session().conceptIndex).toBe(0);
  });

  it("ignores a cancelled touch, such as the browser taking over to scroll", () => {
    const { container, session } = started();
    const el = card(container);
    fireEvent.pointerDown(el, { pointerType: "touch", pointerId: 1, clientX: 300, clientY: 0 });
    fireEvent.pointerCancel(el, { pointerType: "touch", pointerId: 1 });
    fireEvent.pointerUp(el, { pointerType: "touch", pointerId: 1, clientX: 100, clientY: 0 });
    expect(session().conceptIndex).toBe(0);
  });

  it("does not also go on when a button on the card is tapped", () => {
    const { session } = started();
    const more = screen.getByRole("button", { name: /More/ });
    fireEvent.pointerDown(more, { pointerType: "touch", pointerId: 1, clientX: 5, clientY: 5 });
    fireEvent.pointerUp(more, { pointerType: "touch", pointerId: 1, clientX: 5, clientY: 5 });
    expect(session().conceptIndex).toBe(0);
  });

  it("moves exactly one card when Space is pressed on the Next button", async () => {
    const { user, session } = started();
    await user.tab(); // More
    await user.tab(); // Back is disabled, so Next
    expect(screen.getByRole("button", { name: "Next" })).toHaveFocus();
    await user.keyboard(" ");
    expect(session().conceptIndex).toBe(1);
  });

  it.each([
    ["Control", { ctrlKey: true }],
    ["Alt", { altKey: true }],
    ["Meta", { metaKey: true }],
    ["Shift", { shiftKey: true }],
  ])("leaves the arrow keys alone with %s held", (_name, modifier) => {
    const { session } = started();
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowRight",
        bubbles: true,
        cancelable: true,
        ...modifier,
      }),
    );
    expect(session().conceptIndex).toBe(0);
  });

  it("ignores held-down key repeat so one press is one card", () => {
    const { session } = started();
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, repeat: true }),
    );
    expect(session().conceptIndex).toBe(0);
  });

  it("leaves the keys to a dialog that is open, such as settings", () => {
    const { session } = started();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const inner = document.createElement("div");
    inner.tabIndex = -1;
    dialog.append(inner);
    document.body.append(dialog);
    inner.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(session().conceptIndex).toBe(0);
    dialog.remove();
  });

  it("still turns the card with the arrows after a button has been clicked", async () => {
    const { user, session } = started();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("button", { name: "Next" })).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(session().conceptIndex).toBe(2);
    await user.keyboard("{ArrowLeft}");
    expect(session().conceptIndex).toBe(1);
  });

  it("leaves the arrows to a text field and a slider, which use them", () => {
    const { session } = started();
    for (const make of [
      () => Object.assign(document.createElement("input"), { type: "text" }),
      () => Object.assign(document.createElement("input"), { type: "range" }),
      () => document.createElement("select"),
      () => document.createElement("textarea"),
    ]) {
      const el = make();
      document.body.append(el);
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      el.remove();
    }
    expect(session().conceptIndex).toBe(0);
  });

  it("leaves the keys to a text field", () => {
    const { session } = started();
    const input = document.createElement("input");
    document.body.append(input);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(session().conceptIndex).toBe(0);
    input.remove();
  });

  it("ignores the keys and swipes while a question is showing", async () => {
    const { user, session, container } = started({ quiz: { cadence: 1 } });
    await user.keyboard("{ArrowRight}");
    expect(session().phase).toBe("quiz");
    await user.keyboard("{ArrowRight}{ArrowLeft} ");
    fireEvent.pointerDown(card(container), {
      pointerType: "touch",
      pointerId: 1,
      clientX: 300,
      clientY: 0,
    });
    fireEvent.pointerUp(card(container), {
      pointerType: "touch",
      pointerId: 1,
      clientX: 100,
      clientY: 0,
    });
    expect(session().phase).toBe("quiz");
  });

  it("starts each card folded", async () => {
    const { user } = started();
    await user.click(screen.getByRole("button", { name: /More about Evaporation/ }));
    expect(screen.getByRole("button", { name: /Less about Evaporation/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("button", { name: /More about Condensation/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("says which idea is showing when it changes, but not when it first appears", async () => {
    const { user } = started();
    expect(vi.mocked(announce).mock.calls.some(([m]) => m.startsWith("Idea"))).toBe(false);
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(lastAnnounced()).toBe(`Idea 2 of 3: Condensation. ${graph.concepts[1].summary}`);
  });

  it("explains the ways to move, in words", () => {
    started();
    expect(
      screen.getByText(/right arrow or space for next, left arrow for back/),
    ).toBeInTheDocument();
  });

  it("opens a quiz on request", async () => {
    const { user, session } = started();
    await user.click(screen.getByRole("button", { name: "Quiz me" }));
    expect(session().phase).toBe("quiz");
  });
});

describe("CardsRenderer: quiz cards", () => {
  it("shows a quiz card once the learner has seen `cadence` ideas", async () => {
    const { user, session } = started({ quiz: { cadence: 2 } });
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(session().phase).toBe("learning");
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(session().phase).toBe("quiz");
    expect(screen.getByRole("group", { name: "Quick check" })).toBeInTheDocument();
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
  });

  it("uses large option targets", async () => {
    const { user } = started({ quiz: { cadence: 1 } });
    await user.click(screen.getByRole("button", { name: "Next" }));
    const options = within(screen.getByRole("group", { name: "Quick check" }))
      .getAllByRole("button")
      .filter((b) =>
        /vapor|ice|rain|underground|Clouds|Oceans|Rivers|True|False/.test(b.textContent ?? ""),
      );
    expect(options.length).toBeGreaterThanOrEqual(2);
    for (const option of options) expect(option.className).toContain("min-h-14");
  });

  it("moves focus to the question when the card turns into a quiz", async () => {
    const { user } = started({ quiz: { cadence: 1 } });
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("group", { name: "Quick check" })).toHaveFocus();
  });

  it("moves focus to Continue after an answer, not to the card", async () => {
    const ctx = started({ quiz: { cadence: 1 } });
    await ctx.user.click(screen.getByRole("button", { name: "Next" }));
    await answerActive(ctx, true);
    expect(screen.getByRole("button", { name: "Continue" })).toHaveFocus();
  });

  it("goes back to the next card after Continue and focuses it", async () => {
    const ctx = started({ quiz: { cadence: 1 } });
    await ctx.user.click(screen.getByRole("button", { name: "Next" }));
    await answerActive(ctx, true);
    await ctx.user.click(screen.getByRole("button", { name: "Continue" }));
    expect(ctx.session().phase).toBe("learning");
    expect(screen.getByRole("article", { name: "Condensation" })).toHaveFocus();
  });

  it("answers through the session so the same action works in every layout", async () => {
    const ctx = started({ quiz: { cadence: 1 } });
    await ctx.user.click(screen.getByRole("button", { name: "Next" }));
    const id = ctx.session().activeQuizItemId;
    await answerActive(ctx, true);
    expect(ctx.session().lastAnswer).toEqual({ quizItemId: id, correct: true });
  });

  it("grades a short answer locally, with no network", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const ctx = started({ quiz: { cadence: 2, itemsPerCheck: 2 } });
    await ctx.user.click(screen.getByRole("button", { name: "Next" }));
    await ctx.user.click(screen.getByRole("button", { name: "Next" }));
    for (let i = 0; i < 5 && ctx.session().phase === "quiz"; i++) {
      await answerActive(ctx, true);
      if (ctx.session().phase === "feedback")
        await ctx.user.click(screen.getByRole("button", { name: "Continue" }));
    }
    expect(ctx.session().correctCount).toBeGreaterThanOrEqual(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("CardsRenderer: feedback", () => {
  it("states the result in words and announces it, whatever the motion setting", async () => {
    for (const reducedMotion of [false, true]) {
      vi.mocked(announce).mockClear();
      const ctx = started({ quiz: { cadence: 1 }, visual: { reducedMotion } });
      await ctx.user.click(screen.getByRole("button", { name: "Next" }));
      await answerActive(ctx, true);
      expect(screen.getByText("Correct.")).toBeInTheDocument();
      expect(lastAnnounced()).toMatch(/^Correct\./);
      ctx.unmount();
    }
  });

  it("shows a still check mark and runs no animation when reduced motion is on", async () => {
    const ctx = started({
      quiz: { cadence: 1 },
      visual: { reducedMotion: true },
      feedback: { celebration: "full" },
    });
    await ctx.user.click(screen.getByRole("button", { name: "Next" }));
    await answerActive(ctx, true);
    const celebration = document.querySelector("[data-celebration]")!;
    expect(celebration).toHaveAttribute("data-celebration", "still");
    expect(celebration.querySelector(".prism-pop")).toBeNull();
    expect(celebration.querySelector(".prism-burst")).toBeNull();
    expect(celebration).toHaveTextContent("✓");
  });

  it("animates the celebration when motion is allowed", async () => {
    const ctx = started({
      quiz: { cadence: 1 },
      visual: { reducedMotion: false },
      feedback: { celebration: "full" },
    });
    await ctx.user.click(screen.getByRole("button", { name: "Next" }));
    await answerActive(ctx, true);
    const celebration = document.querySelector("[data-celebration]")!;
    expect(celebration).toHaveAttribute("data-celebration", "full");
    expect(celebration.querySelector(".prism-pop")).not.toBeNull();
  });

  it("keeps the tone neutral for a wrong answer: no celebration, the answer and why", async () => {
    const ctx = started({ quiz: { cadence: 1 }, feedback: { celebration: "full" } });
    await ctx.user.click(screen.getByRole("button", { name: "Next" }));
    await answerActive(ctx, false);
    expect(document.querySelector("[data-celebration]")).toBeNull();
    const quiz = within(screen.getByRole("group", { name: "Quick check" }));
    expect(quiz.getByText(/^Not quite\. The answer is/)).toBeInTheDocument();
    expect(lastAnnounced()).toMatch(/^Not quite/);
  });

  it("shows the result with an icon as well as words", async () => {
    const ctx = started({ quiz: { cadence: 1 } });
    await ctx.user.click(screen.getByRole("button", { name: "Next" }));
    await answerActive(ctx, false);
    const quiz = within(screen.getByRole("group", { name: "Quick check" }));
    const result = quiz.getByText(/^Not quite/).closest("p")!;
    expect(result.textContent).toContain("✗");
  });
});

describe("Feedback", () => {
  const profile = (over: Partial<RenderProfile["feedback"]> = {}, reducedMotion = false) => ({
    feedback: { ...presetProfile("standard").feedback, ...over },
    visual: { ...presetProfile("standard").visual, reducedMotion },
  });

  it("renders nothing for a wrong answer or when celebrations are off", () => {
    const { container, rerender } = render(
      <Feedback correct={false} profile={profile({ celebration: "full" })} />,
    );
    expect(container).toBeEmptyDOMElement();
    rerender(<Feedback correct profile={profile({ celebration: "none" })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("is hidden from assistive technology, because it only decorates", () => {
    const { container } = render(<Feedback correct profile={profile({ celebration: "subtle" })} />);
    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
  });

  it("draws a bigger burst for full than for subtle", () => {
    const subtle = render(<Feedback correct profile={profile({ celebration: "subtle" })} />);
    expect(subtle.container.querySelectorAll("[data-burst]")).toHaveLength(0);
    subtle.unmount();
    const full = render(<Feedback correct profile={profile({ celebration: "full" })} />);
    expect(full.container.querySelectorAll("[data-burst]").length).toBeGreaterThan(0);
  });

  it("plays each animation once and never repeats, so nothing flashes", () => {
    const css = readFileSync("src/app/globals.css", "utf8");
    const rule = (name: string) => new RegExp(`\\.${name}\\s*{[^}]*}`).exec(css)![0];
    for (const name of ["prism-pop", "prism-burst"]) {
      expect(rule(name)).toMatch(/\b1\b/);
      expect(rule(name)).not.toMatch(/infinite/);
    }
  });

  it("treats the device's reduced motion setting like the profile's", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const { container } = render(<Feedback correct profile={profile({ celebration: "full" })} />);
    expect(container.firstElementChild).toHaveAttribute("data-celebration", "still");
    expect(container.querySelector(".prism-pop")).toBeNull();
  });

  describe("haptics", () => {
    const vibrate = vi.fn(() => true);
    beforeEach(() => {
      vibrate.mockClear();
      vi.stubGlobal("navigator", { ...navigator, vibrate });
    });

    it("pulses once for a right answer when haptics are on", () => {
      render(<Feedback correct profile={profile({ haptics: true })} />);
      expect(vibrate).toHaveBeenCalledTimes(1);
      expect(vibrate).toHaveBeenCalledWith([40]);
    });

    it("uses a different pattern for a wrong answer", () => {
      render(<Feedback correct={false} profile={profile({ haptics: true })} />);
      expect(vibrate).toHaveBeenCalledWith([30, 60, 30]);
    });

    it("does nothing when haptics are off", () => {
      render(<Feedback correct profile={profile({ haptics: false })} />);
      expect(vibrate).not.toHaveBeenCalled();
    });

    it("pulses even when motion is reduced, because it is not motion", () => {
      render(<Feedback correct profile={profile({ haptics: true }, true)} />);
      expect(vibrate).toHaveBeenCalled();
    });

    it("does not break where the Vibration API is missing", () => {
      vi.stubGlobal("navigator", {});
      expect(() => render(<Feedback correct profile={profile({ haptics: true })} />)).not.toThrow();
    });
  });
});

describe("CardsRenderer: progress and streaks", () => {
  it("shows a progress bar that advances with the ideas seen", async () => {
    const { user } = started();
    const bar = () => screen.getByRole("progressbar", { name: "Lesson progress" });
    expect(bar()).toHaveAttribute("value", "33");
    expect(screen.getByText("Idea 1 of 3")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(bar()).toHaveAttribute("value", "67");
  });

  it("hides the progress bar when the learner has turned it off", () => {
    started({ feedback: { progressBar: false } });
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("shows a streak only when streaks are on and there is one", async () => {
    const ctx = started({ quiz: { cadence: 1 }, feedback: { streaks: true } });
    expect(screen.queryByText(/Streak/)).not.toBeInTheDocument();
    await ctx.user.click(screen.getByRole("button", { name: "Next" }));
    await answerActive(ctx, true);
    expect(screen.getByText(/Streak: 1 answer in a row/)).toBeInTheDocument();
  });

  it("never shows a streak when the learner has not asked for one", async () => {
    const ctx = started({ quiz: { cadence: 1 }, feedback: { streaks: false } });
    await ctx.user.click(screen.getByRole("button", { name: "Next" }));
    await answerActive(ctx, true);
    expect(screen.queryByText(/Streak/)).not.toBeInTheDocument();
  });

  it("drops the streak after a wrong answer", async () => {
    const ctx = started({ quiz: { cadence: 1, retryOnWrong: false }, feedback: { streaks: true } });
    await ctx.user.click(screen.getByRole("button", { name: "Next" }));
    await answerActive(ctx, false);
    expect(screen.queryByText(/Streak/)).not.toBeInTheDocument();
  });
});

describe("CardsRenderer: the summary", () => {
  async function finish(ctx: ReturnType<typeof setup>, correct = true) {
    await ctx.user.click(screen.getByRole("button", { name: "Start" }));
    await ctx.user.click(screen.getByRole("button", { name: "Next" }));
    await ctx.user.click(screen.getByRole("button", { name: "Next" }));
    await ctx.user.click(screen.getByRole("button", { name: "Next" }));
    for (let i = 0; i < 6 && ctx.session().phase !== "complete"; i++) {
      if (ctx.session().phase === "quiz") await answerActive(ctx, correct);
      if (ctx.session().phase === "feedback")
        await ctx.user.click(screen.getByRole("button", { name: "Continue" }));
    }
  }

  it("shows concepts mastered and active time at the end", async () => {
    const ctx = setup({
      quiz: { cadence: 5, itemsPerCheck: 3, retryOnWrong: false },
      feedback: { streaks: true },
    });
    clock.t = 0;
    const times = [0, 60_000, 150_000, 240_000, 300_000, 360_000, 420_000, 480_000];
    let i = 0;
    const tick = () => void (clock.t = times[Math.min(i++, times.length - 1)]);
    ctx.sessionStore.subscribe(tick);
    await finish(ctx);
    expect(ctx.session().phase).toBe("complete");
    const summary = screen.getByRole("region", { name: "Lesson complete" });
    expect(within(summary).getByText("Ideas mastered").nextElementSibling).toHaveTextContent(
      /^\d of 3$/,
    );
    expect(within(summary).getByText("Time spent").nextElementSibling).toHaveTextContent(/minute/);
    expect(within(summary).getByText("Best streak")).toBeInTheDocument();
  });

  it("counts only ideas with two right answers in a row as mastered", async () => {
    const ctx = setup({ quiz: { cadence: 5, itemsPerCheck: 3 } });
    await finish(ctx, true);
    const mastered = Object.values(ctx.session().conceptRun).filter((run) => run >= 2).length;
    const row = screen.getByText("Ideas mastered").nextElementSibling!;
    expect(row).toHaveTextContent(`${mastered} of 3`);
  });

  it("leaves out the streak when the learner has not turned streaks on", async () => {
    const ctx = setup({ feedback: { streaks: false } });
    await finish(ctx);
    expect(screen.queryByText("Best streak")).not.toBeInTheDocument();
  });

  it("focuses the summary when the lesson ends", async () => {
    const ctx = setup();
    await finish(ctx);
    expect(screen.getByRole("region", { name: "Lesson complete" })).toHaveFocus();
  });

  it("starts the lesson again from the summary", async () => {
    const ctx = setup();
    await finish(ctx);
    await ctx.user.click(screen.getByRole("button", { name: "Go through it again" }));
    expect(ctx.session().phase).toBe("intro");
    expect(screen.getByRole("button", { name: "Start" })).toBeInTheDocument();
  });

  it("shows full progress at the end", async () => {
    const ctx = setup();
    await finish(ctx);
    expect(screen.getByRole("progressbar", { name: "Lesson progress" })).toHaveAttribute(
      "value",
      "100",
    );
    expect(screen.getByText("Complete")).toBeInTheDocument();
  });
});

describe("SummaryCard", () => {
  const base = {
    totalConcepts: 4,
    masteredConcepts: 2,
    correctCount: 5,
    answeredCount: 6,
    bestStreak: 3,
    activeMs: 7 * 60_000,
    showStreak: true,
    onRestart: () => {},
  };

  it("states each figure in words", () => {
    render(<SummaryCard {...base} />);
    expect(screen.getByText("2 of 4")).toBeInTheDocument();
    expect(screen.getByText("5 of 6")).toBeInTheDocument();
    expect(screen.getByText("3 answers in a row")).toBeInTheDocument();
    expect(screen.getByText("7 minutes")).toBeInTheDocument();
  });

  it("congratulates only when every idea is mastered", () => {
    const { rerender } = render(<SummaryCard {...base} />);
    expect(screen.getByText(/worth another look/)).toBeInTheDocument();
    rerender(<SummaryCard {...base} masteredConcepts={4} />);
    expect(screen.getByText(/mastered every idea/)).toBeInTheDocument();
  });

  it("copes with no questions having been asked and no time spent", () => {
    render(
      <SummaryCard {...base} answeredCount={0} correctCount={0} bestStreak={0} activeMs={0} />,
    );
    expect(screen.getByText("None asked")).toBeInTheDocument();
    expect(screen.getByText("Less than a minute")).toBeInTheDocument();
    expect(screen.getByText("0 answers in a row")).toBeInTheDocument();
  });

  it("has no axe violations", async () => {
    const { container } = render(<SummaryCard {...base} />);
    await expectNoAxeViolations(container);
  });
});

describe("CardsRenderer: accessibility", () => {
  it("has no axe violations in any phase", async () => {
    const ctx = setup({ quiz: { cadence: 1 } });
    await expectNoAxeViolations(ctx.container);
    await ctx.user.click(screen.getByRole("button", { name: "Start" }));
    await expectNoAxeViolations(ctx.container);
    await ctx.user.click(screen.getByRole("button", { name: "More about Evaporation" }));
    await expectNoAxeViolations(ctx.container);
    await ctx.user.click(screen.getByRole("button", { name: "Next" }));
    await expectNoAxeViolations(ctx.container); // quiz
    await answerActive(ctx, true);
    await expectNoAxeViolations(ctx.container); // feedback
    await ctx.user.click(screen.getByRole("button", { name: "Continue" }));
    await expectNoAxeViolations(ctx.container);
  });

  it("has no heading level skipped", async () => {
    const ctx = started();
    const levels = [...ctx.container.querySelectorAll("h1,h2,h3,h4,h5,h6")].map((h) =>
      Number(h.tagName[1]),
    );
    expect(levels).toEqual([1, 2]);
  });

  it("is operable by keyboard from start to finish", async () => {
    const ctx = setup({ quiz: { cadence: 5, itemsPerCheck: 1 } });
    await ctx.user.tab();
    await ctx.user.keyboard("{Enter}"); // Start
    await ctx.user.keyboard("{ArrowRight}{ArrowRight}{ArrowRight}");
    expect(ctx.session().phase).toBe("quiz");
    const buttons = within(screen.getByRole("group", { name: "Quick check" })).getAllByRole(
      "button",
    );
    buttons[0].focus();
    await ctx.user.keyboard("{Enter}");
    expect(ctx.session().phase).toBe("feedback");
    await ctx.user.keyboard("{Enter}"); // focus is already on Continue
    expect(["complete", "quiz"]).toContain(ctx.session().phase);
  });
});
