// @vitest-environment jsdom
import { act, render, renderHook, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { presetProfile } from "@/lib/profile/presets";
import { createProfileStore } from "@/lib/profile/store";
import { createSessionStore } from "@/lib/session/store";
import { PrismRenderer } from "@/renderers/PrismRenderer";
import { profileStyleVars, useProfileStyles } from "@/renderers/shared/useProfileStyles";
import { makeGraph } from "../fixtures/graph";

describe("profileStyleVars", () => {
  it("maps the defaults", () => {
    expect(profileStyleVars(presetProfile("standard"))).toEqual({
      "--type-scale": "1",
      "--letter-spacing": "0em",
      "--word-spacing": "0em",
      "--line-height": "1.5",
      "--measure": "70ch",
    });
  });

  it("maps the easy reading preset", () => {
    expect(profileStyleVars(presetProfile("cognitive_ease"))).toMatchObject({
      "--letter-spacing": "0.05em",
      "--word-spacing": "0.16em",
      "--line-height": "1.8",
      "--measure": "60ch",
    });
  });

  it("carries a custom size scale", () => {
    const profile = presetProfile("standard");
    profile.typography.sizeScale = 1.75;
    expect(profileStyleVars(profile)["--type-scale"]).toBe("1.75");
  });
});

describe("useProfileStyles", () => {
  it("returns the theme, font and reduced motion as data attributes", () => {
    const profile = presetProfile("cognitive_ease");
    const { result } = renderHook(() => useProfileStyles(profile));
    expect(result.current).toMatchObject({
      "data-theme": "cream",
      "data-font": "lexend",
      "data-reduced-motion": "false",
      "data-prism-root": "",
    });
  });

  it("turns reduced motion on from the profile", () => {
    const profile = presetProfile("standard");
    profile.visual.reducedMotion = true;
    const { result } = renderHook(() => useProfileStyles(profile));
    expect(result.current["data-reduced-motion"]).toBe("true");
  });

  it.each(["system", "light", "dark", "high_contrast", "cream", "blue_tint"] as const)(
    "passes the %s theme through",
    (theme) => {
      const profile = presetProfile("standard");
      profile.visual.theme = theme;
      expect(renderHook(() => useProfileStyles(profile)).result.current["data-theme"]).toBe(theme);
    },
  );

  it.each(["system", "atkinson", "lexend", "opendyslexic"] as const)(
    "passes the %s font through",
    (font) => {
      const profile = presetProfile("standard");
      profile.typography.font = font;
      expect(renderHook(() => useProfileStyles(profile)).result.current["data-font"]).toBe(font);
    },
  );

  it("keeps the same style object when an unrelated setting changes", () => {
    const base = presetProfile("standard");
    const { result, rerender } = renderHook(({ profile }) => useProfileStyles(profile), {
      initialProps: { profile: base },
    });
    const first = result.current;
    const changed = { ...base, quiz: { ...base.quiz, cadence: 2 } };
    rerender({ profile: changed });
    expect(result.current).toBe(first);
  });

  it("produces a new style object when a typography setting changes", () => {
    const base = presetProfile("standard");
    const { result, rerender } = renderHook(({ profile }) => useProfileStyles(profile), {
      initialProps: { profile: base },
    });
    const first = result.current;
    rerender({ profile: { ...base, typography: { ...base.typography, lineHeight: 2 } } });
    expect(result.current).not.toBe(first);
    expect(result.current.style["--line-height" as keyof typeof result.current.style]).toBe("2");
  });
});

describe("PrismRenderer applies the profile styles live", () => {
  function setup() {
    const graph = makeGraph();
    const profileStore = createProfileStore({ storage: null });
    const sessionStore = createSessionStore({
      lessonId: graph.lessonId,
      graphVersion: 1,
      graph,
      getSettings: () => ({ cadence: 5, itemsPerCheck: 1, retryOnWrong: true }),
      storage: null,
    });
    const view = render(
      <PrismRenderer graph={graph} sessionStore={sessionStore} profileStore={profileStore} />,
    );
    return { profileStore, view };
  }

  const root = () => document.querySelector("[data-prism-root]") as HTMLElement;

  it("updates the line height without remounting", async () => {
    const { profileStore } = setup();
    const heading = await screen.findByRole("heading", { name: /reading view/ });
    const rootBefore = root();
    expect(rootBefore.style.getPropertyValue("--line-height")).toBe("1.5");

    act(() => profileStore.getState().applyPatch({ typography: { lineHeight: 2 } }));

    expect(root().style.getPropertyValue("--line-height")).toBe("2");
    expect(root()).toBe(rootBefore); // the same element: not remounted
    expect(screen.getByRole("heading", { name: /reading view/ })).toBe(heading); // nor its content
  });

  it("updates spacing, size and measure live", async () => {
    const { profileStore } = setup();
    await screen.findByRole("heading", { name: /reading view/ });
    act(() =>
      profileStore.getState().applyPatch({
        typography: { letterSpacing: 0.1, wordSpacing: 0.3, sizeScale: 1.5, maxLineLength: 50 },
      }),
    );
    const style = root().style;
    expect(style.getPropertyValue("--letter-spacing")).toBe("0.1em");
    expect(style.getPropertyValue("--word-spacing")).toBe("0.3em");
    expect(style.getPropertyValue("--type-scale")).toBe("1.5");
    expect(style.getPropertyValue("--measure")).toBe("50ch");
  });

  it("switches theme and font by attribute", async () => {
    const { profileStore } = setup();
    await screen.findByRole("heading", { name: /reading view/ });
    act(() =>
      profileStore
        .getState()
        .applyPatch({ visual: { theme: "high_contrast" }, typography: { font: "atkinson" } }),
    );
    expect(root()).toHaveAttribute("data-theme", "high_contrast");
    expect(root()).toHaveAttribute("data-font", "atkinson");
  });

  it("applies the reduced motion setting", async () => {
    const { profileStore } = setup();
    await screen.findByRole("heading", { name: /reading view/ });
    expect(root()).toHaveAttribute("data-reduced-motion", "false");
    act(() => profileStore.getState().applyPatch({ visual: { reducedMotion: true } }));
    expect(root()).toHaveAttribute("data-reduced-motion", "true");
  });
});
