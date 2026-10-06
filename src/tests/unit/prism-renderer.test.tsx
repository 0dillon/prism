// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { announce, LiveRegions } from "@/lib/a11y/live-region";
import { createProfileStore } from "@/lib/profile/store";
import { createSessionStore } from "@/lib/session/store";
import { PrismRenderer } from "@/renderers/PrismRenderer";
import { LAYOUTS, loadRenderer, rendererLoaders } from "@/renderers/registry";
import { RENDERER_HEADING_ATTRIBUTE } from "@/renderers/types";
import { expectNoAxeViolations } from "../a11y";
import { makeGraph } from "../fixtures/graph";

vi.mock("@/lib/a11y/live-region", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/a11y/live-region")>();
  return { ...original, announce: vi.fn(original.announce) };
});

function setup() {
  const graph = makeGraph();
  const profileStore = createProfileStore({ storage: null });
  const sessionStore = createSessionStore({
    lessonId: graph.lessonId,
    graphVersion: 1,
    graph,
    getSettings: () => ({
      cadence: profileStore.getState().profile.quiz.cadence,
      itemsPerCheck: profileStore.getState().profile.quiz.itemsPerCheck,
      retryOnWrong: profileStore.getState().profile.quiz.retryOnWrong,
    }),
    storage: null,
  });
  render(
    <>
      <PrismRenderer graph={graph} sessionStore={sessionStore} profileStore={profileStore} />
      <LiveRegions />
    </>,
  );
  return { graph, profileStore, sessionStore };
}

const heading = () => document.querySelector(`[${RENDERER_HEADING_ATTRIBUTE}]`) as HTMLElement;

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.mocked(announce).mockClear();
  fetchSpy = vi.fn(async () => {
    throw new Error("a layout switch must not use the network");
  });
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("renderer registry", () => {
  it.each(LAYOUTS)("resolves the %s layout to a component", async (layout) => {
    expect(typeof rendererLoaders[layout]).toBe("function");
    expect(typeof (await loadRenderer(layout))).toBe("function");
  });

  it("covers exactly the four layouts in the schema", () => {
    expect([...LAYOUTS].sort()).toEqual(["cards", "conversation", "reader", "visual"]);
    expect(Object.keys(rendererLoaders).sort()).toEqual([...LAYOUTS].sort());
  });
});

describe("PrismRenderer", () => {
  it("renders the renderer for the profile's layout", async () => {
    const { profileStore } = setup();
    expect(await screen.findByRole("heading", { name: /reading view/ })).toBeInTheDocument();
    act(() => profileStore.getState().applyPreset("hyper_focus"));
    expect(await screen.findByRole("heading", { name: /cards view/ })).toBeInTheDocument();
  });

  it("keeps the session identical when the layout switches", async () => {
    const { profileStore, sessionStore } = setup();
    await screen.findByRole("heading", { name: /reading view/ });
    act(() => sessionStore.getState().start());
    act(() => sessionStore.getState().next());
    const before = sessionStore.getState().session;
    expect(before).toMatchObject({ phase: "learning", conceptIndex: 1 });

    for (const preset of ["hyper_focus", "voice_native", "visual_sign", "standard"] as const) {
      act(() => profileStore.getState().applyPreset(preset));
      await waitFor(() => expect(heading()).toBeTruthy());
      expect(sessionStore.getState().session).toBe(before); // the very same object: nothing touched it
    }
  });

  it("still shows the same concept after switching layout", async () => {
    const { profileStore, sessionStore } = setup();
    await screen.findByRole("heading", { name: /reading view/ });
    act(() => sessionStore.getState().start());
    act(() => sessionStore.getState().next());
    expect(await screen.findByText("Condensation")).toBeInTheDocument();
    act(() => profileStore.getState().applyPreset("hyper_focus"));
    await screen.findByRole("heading", { name: /cards view/ });
    expect(screen.getByText("Condensation")).toBeInTheDocument();
  });

  it("makes zero network requests when switching layout", async () => {
    const { profileStore } = setup();
    await screen.findByRole("heading", { name: /reading view/ });
    for (const preset of ["hyper_focus", "voice_native", "visual_sign"] as const) {
      act(() => profileStore.getState().applyPreset(preset));
      await waitFor(() => expect(heading()).toBeTruthy());
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("moves focus to the new renderer's heading and announces the change", async () => {
    const { profileStore } = setup();
    await screen.findByRole("heading", { name: /reading view/ });
    act(() => profileStore.getState().applyPreset("hyper_focus"));
    const cards = await screen.findByRole("heading", { name: /cards view/ });
    await waitFor(() => expect(cards).toHaveFocus());
    expect(vi.mocked(announce).mock.calls.at(-1)?.[0]).toBe("Switched to the cards view.");
  });

  it("does not steal focus or announce on the first render", async () => {
    setup();
    const initial = await screen.findByRole("heading", { name: /reading view/ });
    expect(initial).not.toHaveFocus();
    expect(vi.mocked(announce)).not.toHaveBeenCalled();
  });

  it("announces each switch once", async () => {
    const { profileStore } = setup();
    await screen.findByRole("heading", { name: /reading view/ });
    act(() => profileStore.getState().applyPreset("voice_native"));
    await screen.findByRole("heading", { name: /conversation view/ });
    act(() => profileStore.getState().applyPreset("visual_sign"));
    await screen.findByRole("heading", { name: /visual view/ });
    const messages = vi.mocked(announce).mock.calls.map(([m]) => m);
    expect(messages.filter((m) => m.startsWith("Switched to"))).toEqual([
      "Switched to the conversation view.",
      "Switched to the visual view.",
    ]);
  });

  it("does not announce when a setting changes but the layout does not", async () => {
    const { profileStore } = setup();
    await screen.findByRole("heading", { name: /reading view/ });
    act(() => profileStore.getState().applyPatch({ typography: { sizeScale: 1.5 } }));
    expect(vi.mocked(announce)).not.toHaveBeenCalled();
  });

  it("passes the session actions through to the renderer", async () => {
    const { sessionStore } = setup();
    const button = await screen.findByRole("button", { name: "Start" });
    act(() => button.click());
    expect(sessionStore.getState().session.phase).toBe("learning");
  });

  it("prefetches the other renderers after the first paint", async () => {
    const spies = Object.fromEntries(
      LAYOUTS.map((layout) => [layout, vi.spyOn(rendererLoaders, layout)]),
    );
    setup();
    await screen.findByRole("heading", { name: /reading view/ });
    await waitFor(() => {
      for (const layout of LAYOUTS) expect(spies[layout]).toHaveBeenCalled();
    });
  });

  it("has no axe violations in each layout", async () => {
    const { profileStore } = setup();
    await screen.findByRole("heading", { name: /reading view/ });
    await expectNoAxeViolations(document.body, { rules: ["landmark-unique"] });
    for (const preset of ["hyper_focus", "voice_native", "visual_sign"] as const) {
      act(() => profileStore.getState().applyPreset(preset));
      await waitFor(() => expect(heading()).toBeTruthy());
      await expectNoAxeViolations(document.body, { rules: ["landmark-unique"] });
    }
  });
});
