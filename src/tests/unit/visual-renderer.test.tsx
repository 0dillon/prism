// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useMemo } from "react";
import type { StoreApi } from "zustand/vanilla";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProfilePatch } from "@/lib/profile/merge";
import { createProfileStore, useProfile, type ProfileStore } from "@/lib/profile/store";
import { createSessionStore, useSession, type SessionStore } from "@/lib/session/store";
import { loadLearnerSignClips, toClipMap } from "@/lib/lessons/sign-clips-service";
import { Fingerspell, fingerspellItems } from "@/renderers/visual/Fingerspell";
import { SignClip, SPEEDS } from "@/renderers/visual/SignClip";
import { SIGN_NOTICE, SignClipsContext, type SignClipMap } from "@/renderers/visual/signs";
import VisualRenderer from "@/renderers/visual/VisualRenderer";
import { createFixedVariantSource, VariantSourceContext } from "@/renderers/shared/variant-source";
import type { SessionActions } from "@/renderers/types";
import { expectNoAxeViolations } from "../a11y";
import { makeGraph } from "../fixtures/graph";

const graph = makeGraph();

const CLIPS: SignClipMap = {
  c_evaporation: {
    gloss: "EVAPORATE",
    url: "https://example.test/evaporate.mp4",
    license: "CC BY 4.0",
    signerCredit: "A. Signer",
  },
};

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
    <VisualRenderer
      graph={graph}
      session={session}
      profile={profile}
      actions={actions}
      updateProfile={(p: ProfilePatch) => profileStore.getState().applyPatch(p)}
    />
  );
}

function setup(options: { clips?: SignClipMap; patch?: ProfilePatch; start?: boolean } = {}) {
  const profileStore = createProfileStore({ storage: null });
  profileStore.getState().applyPreset("visual_sign");
  profileStore
    .getState()
    .applyPatch({ content: { readingLevel: "original" }, quiz: { cadence: 5, itemsPerCheck: 1 } });
  if (options.patch) profileStore.getState().applyPatch(options.patch);
  const sessionStore = createSessionStore({
    lessonId: graph.lessonId,
    graphVersion: 1,
    graph,
    getSettings: () => ({ cadence: 5, itemsPerCheck: 1, retryOnWrong: false }),
    storage: null,
  });
  const user = userEvent.setup();
  const view = render(
    <SignClipsContext.Provider value={options.clips ?? {}}>
      <Harness sessionStore={sessionStore} profileStore={profileStore} />
    </SignClipsContext.Provider>,
  );
  if (options.start !== false) act(() => sessionStore.getState().start());
  return {
    user,
    sessionStore,
    profileStore,
    session: () => sessionStore.getState().session,
    ...view,
  };
}

async function answerActive(ctx: ReturnType<typeof setup>, correct: boolean) {
  const item = graph.quizItems.find((q) => q.id === ctx.session().activeQuizItemId)!;
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

afterEach(() => vi.unstubAllGlobals());

describe("VisualRenderer: the card", () => {
  it("shows the idea as a card with a heading, its text, the key term and the sign notice", () => {
    const { container } = setup();
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    expect(
      screen.getByRole("heading", { level: 1, name: "The Water Cycle, visual view" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Evaporation" })).toBeInTheDocument();
    expect(screen.getByText(/The sun warms water in oceans/)).toBeInTheDocument();
    expect(screen.getByText(/Liquid water changing into vapor/)).toBeInTheDocument();
    expect(screen.getByText(SIGN_NOTICE)).toBeInTheDocument();
  });

  it("starts with an overview and a Start button", () => {
    setup({ start: false });
    expect(screen.getByText(graph.overview)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start" })).toBeInTheDocument();
  });

  it("goes on and back by button, arrow key and swipe-free keys", async () => {
    const ctx = setup();
    await ctx.user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("heading", { level: 2, name: "Condensation" })).toBeInTheDocument();
    await ctx.user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("heading", { level: 2, name: "Evaporation" })).toBeInTheDocument();
  });

  it("states the sign notice only when signs are turned on", () => {
    setup({ patch: { visual: { signClips: false } } });
    expect(screen.queryByText(SIGN_NOTICE)).not.toBeInTheDocument();
    expect(screen.queryByText(/Fingerspelled/)).not.toBeInTheDocument();
  });

  it("uses the plain wording when the profile asks for it", async () => {
    const source = createFixedVariantSource(
      { c_evaporation: { plain: "Easy plain words.", simple: "x" } },
      1,
    );
    const profileStore = createProfileStore({ storage: null });
    profileStore.getState().applyPreset("visual_sign");
    const sessionStore = createSessionStore({
      lessonId: graph.lessonId,
      graphVersion: 1,
      graph,
      getSettings: () => ({ cadence: 5, itemsPerCheck: 1, retryOnWrong: false }),
      storage: null,
    });
    render(
      <VariantSourceContext.Provider value={source}>
        <Harness sessionStore={sessionStore} profileStore={profileStore} />
      </VariantSourceContext.Provider>,
    );
    act(() => sessionStore.getState().start());
    expect(await screen.findByText("Easy plain words.")).toBeInTheDocument();
    expect(screen.queryByText(/The sun warms water in oceans/)).not.toBeInTheDocument();
  });

  it("has no axe violations", async () => {
    const ctx = setup({ clips: CLIPS });
    await expectNoAxeViolations(ctx.container);
    await ctx.user.click(screen.getByRole("button", { name: "See it signed" }));
    await expectNoAxeViolations(ctx.container);
  });
});

describe("VisualRenderer: signs", () => {
  it("shows See it signed for a concept with a verified clip, and not for one without", async () => {
    const ctx = setup({ clips: CLIPS });
    expect(screen.getByRole("button", { name: "See it signed" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByText(/Fingerspelled/)).not.toBeInTheDocument();
    await ctx.user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.queryByRole("button", { name: "See it signed" })).not.toBeInTheDocument();
    expect(screen.getByText("Fingerspelled: condensation")).toBeInTheDocument();
  });

  it("opens the clip in place, and closes it again", async () => {
    const ctx = setup({ clips: CLIPS });
    const open = screen.getByRole("button", { name: "See it signed" });
    await ctx.user.click(open);
    expect(open).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Sign: EVAPORATE")).toBeInTheDocument();
    await ctx.user.click(open);
    expect(screen.queryByText("Sign: EVAPORATE")).not.toBeInTheDocument();
  });

  it("never starts a video by itself", async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    const ctx = setup({ clips: CLIPS });
    await ctx.user.click(screen.getByRole("button", { name: "See it signed" }));
    expect(play).not.toHaveBeenCalled();
    play.mockRestore();
  });

  it("shows every key term fingerspelled when there are no clips", async () => {
    const ctx = setup();
    for (const term of ["evaporation", "condensation", "precipitation"]) {
      expect(screen.getByText(`Fingerspelled: ${term}`)).toBeInTheDocument();
      if (term !== "precipitation")
        await ctx.user.click(screen.getByRole("button", { name: "Next" }));
    }
  });
});

describe("VisualRenderer: quizzes with no sound (P4-29)", () => {
  it("shows the result with an icon, words and a still check, and uses no audio or speech", async () => {
    const speak = vi.fn();
    const audioContext = vi.fn();
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.stubGlobal("speechSynthesis", { speak, cancel: vi.fn(), getVoices: () => [] });
    vi.stubGlobal("SpeechSynthesisUtterance", class {});
    vi.stubGlobal("AudioContext", audioContext);
    vi.stubGlobal("Audio", vi.fn());
    const ctx = setup({ patch: { audio: { earcons: true, readAloud: true } } });
    await ctx.user.click(screen.getByRole("button", { name: "Quiz me" }));
    await answerActive(ctx, true);
    const group = screen.getByRole("group", { name: "Quick check" });
    expect(within(group).getByText("Correct.").closest("p")!.textContent).toContain("✓");
    expect(document.querySelector("[data-celebration]")).not.toBeNull();
    await ctx.user.click(screen.getByRole("button", { name: "Continue" }));
    await ctx.user.click(screen.getByRole("button", { name: "Quiz me" }));
    await answerActive(ctx, false);
    expect(
      within(screen.getByRole("group", { name: "Quick check" }))
        .getByText(/Not quite/)
        .closest("p")!.textContent,
    ).toContain("✗");

    expect(speak).not.toHaveBeenCalled();
    expect(audioContext).not.toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
    expect(ctx.container.querySelector("audio")).toBeNull();
    play.mockRestore();
  });

  it("completes a whole lesson without using any speech or audio", async () => {
    const speak = vi.fn();
    vi.stubGlobal("speechSynthesis", { speak, cancel: vi.fn(), getVoices: () => [] });
    const ctx = setup();
    for (let i = 0; i < 3; i++) await ctx.user.click(screen.getByRole("button", { name: "Next" }));
    while (ctx.session().phase === "quiz" || ctx.session().phase === "feedback") {
      if (ctx.session().phase === "quiz") await answerActive(ctx, true);
      else await ctx.user.click(screen.getByRole("button", { name: "Continue" }));
    }
    await waitFor(() => expect(ctx.session().phase).toBe("complete"));
    expect(screen.getByRole("heading", { name: "Lesson complete" })).toBeInTheDocument();
    expect(speak).not.toHaveBeenCalled();
    expect(ctx.container.querySelector("audio")).toBeNull();
  });

  it("vibrates on a phone when haptics are on", async () => {
    const vibrate = vi.fn(() => true);
    vi.stubGlobal("navigator", { ...navigator, vibrate });
    const ctx = setup({ patch: { feedback: { haptics: true } } });
    await ctx.user.click(screen.getByRole("button", { name: "Quiz me" }));
    await answerActive(ctx, true);
    expect(vibrate).toHaveBeenCalled();
  });
});

describe("SignClip", () => {
  const clip = CLIPS.c_evaporation;

  it("is a labelled figure with the gloss, a note, the credit and a muted looping video", () => {
    const { container } = render(<SignClip clip={clip} term="evaporation" />);
    const video = container.querySelector("video")!;
    expect(video.muted).toBe(true);
    expect(video.loop).toBe(true);
    expect(video.autoplay).toBe(false);
    expect(video).toHaveAttribute("aria-label", "A signer showing the sign for EVAPORATE");
    expect(screen.getByText("Sign: EVAPORATE")).toBeInTheDocument();
    expect(
      screen.getByText("This shows the sign for the key term evaporation."),
    ).toBeInTheDocument();
    expect(screen.getByText(/Signer: A\. Signer\. CC BY 4\.0\./)).toBeInTheDocument();
  });

  it("plays and pauses with a button that reports its state", async () => {
    const user = userEvent.setup();
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (
      this: HTMLMediaElement,
    ) {
      Object.defineProperty(this, "paused", { value: false, configurable: true });
      this.dispatchEvent(new Event("play"));
      return Promise.resolve();
    });
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (
      this: HTMLMediaElement,
    ) {
      Object.defineProperty(this, "paused", { value: true, configurable: true });
      this.dispatchEvent(new Event("pause"));
    });
    render(<SignClip clip={clip} term="evaporation" />);
    const button = screen.getByRole("button", { name: "Play" });
    expect(button).toHaveAttribute("aria-pressed", "false");
    await user.click(button);
    expect(screen.getByRole("button", { name: "Pause" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Pause" }));
    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
    expect(play).toHaveBeenCalledTimes(1);
    expect(pause).toHaveBeenCalledTimes(1);
    play.mockRestore();
    pause.mockRestore();
  });

  it("is operable by keyboard", async () => {
    const user = userEvent.setup();
    render(<SignClip clip={clip} term="evaporation" />);
    await user.tab();
    expect(screen.getByRole("button", { name: "Play" })).toHaveFocus();
    await user.tab();
    expect(screen.getByLabelText("Speed")).toHaveFocus();
  });

  it("changes the playback speed", async () => {
    const user = userEvent.setup();
    const { container } = render(<SignClip clip={clip} term="evaporation" />);
    expect(
      [...(screen.getByLabelText("Speed") as HTMLSelectElement).options].map((o) => o.textContent),
    ).toEqual(["0.5×", "0.75×", "Normal"]);
    await user.selectOptions(screen.getByLabelText("Speed"), "0.5");
    expect(container.querySelector("video")!.playbackRate).toBe(0.5);
    expect(SPEEDS).toEqual([0.5, 0.75, 1]);
  });

  it("says so, and disables Play, when the video cannot be played", async () => {
    const { container } = render(<SignClip clip={clip} term="evaporation" />);
    act(() => void container.querySelector("video")!.dispatchEvent(new Event("error")));
    expect(screen.getByRole("status")).toHaveTextContent(/could not be played/);
    expect(screen.getByRole("button", { name: "Play" })).toBeDisabled();
  });

  it("leaves out the credit when there is none", () => {
    render(<SignClip clip={{ ...clip, signerCredit: null }} term="evaporation" />);
    expect(screen.queryByText(/Signer:/)).not.toBeInTheDocument();
  });

  it("has no axe violations", async () => {
    const { container } = render(<SignClip clip={clip} term="evaporation" />);
    await expectNoAxeViolations(container);
  });
});

describe("Fingerspell", () => {
  it("spells any A to Z term with a text alternative for each letter", () => {
    const alphabet = "abcdefghijklmnopqrstuvwxyz";
    render(<Fingerspell term={alphabet} />);
    for (const letter of alphabet.toUpperCase()) {
      expect(screen.getByRole("img", { name: `Letter ${letter}` })).toBeInTheDocument();
    }
  });

  it("is labelled as fingerspelling, never as signing", () => {
    render(<Fingerspell term="cloud" />);
    expect(screen.getByText("Fingerspelled: cloud")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "cloud, fingerspelled" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Letters: C, L, O, U, D" })).toBeInTheDocument();
  });

  it("keeps a gap between words and drops what has no handshape", () => {
    expect(
      fingerspellItems("water cycle")
        .map((i) => i.value)
        .join(""),
    ).toBe("WATER CYCLE");
    expect(fingerspellItems("co-op!").map((i) => i.kind)).toEqual([
      "letter",
      "letter",
      "space",
      "letter",
      "letter",
    ]);
    expect(fingerspellItems("  a  ").map((i) => i.value)).toEqual(["A"]);
    expect(fingerspellItems("2024")).toEqual([]);
    expect(
      fingerspellItems("naïve")
        .map((i) => i.value)
        .join(""),
    ).toBe("NAIVE");
  });

  it("renders nothing for a term with no letters", () => {
    const { container } = render(<Fingerspell term="123" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("has no axe violations", async () => {
    const { container } = render(<Fingerspell term="water cycle" />);
    await expectNoAxeViolations(container);
  });
});

describe("loadLearnerSignClips", () => {
  const row = (conceptId: string, verified: boolean, clip: unknown) => ({
    concept_id: conceptId,
    verified,
    sign_clips: clip,
  });
  const client = (rows: unknown[], error: unknown = null) => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      then: (resolve: (v: unknown) => void) => resolve({ data: rows, error }),
    };
    return { from: () => chain } as never;
  };
  const clip = { gloss: "G", storage_path: "p.mp4", license: "CC BY", signer_credit: null };

  it("returns the verified clips with signed URLs", async () => {
    const rows = await loadLearnerSignClips(client([row("c1", true, clip)]), "l", {
      signUrl: async (p) => `https://x/${p}`,
    });
    expect(rows).toEqual([
      { conceptId: "c1", gloss: "G", url: "https://x/p.mp4", license: "CC BY", signerCredit: null },
    ]);
  });

  it("never returns an unverified link, even if one reaches it", async () => {
    expect(
      await loadLearnerSignClips(client([row("c1", false, clip)]), "l", {
        signUrl: async () => "u",
      }),
    ).toEqual([]);
  });

  it("leaves out a clip whose URL cannot be made", async () => {
    expect(
      await loadLearnerSignClips(client([row("c1", true, clip)]), "l", {
        signUrl: async () => null,
      }),
    ).toEqual([]);
  });

  it("copes with the clip arriving as a list, a missing clip and a read error", async () => {
    const listed = await loadLearnerSignClips(
      client([row("c1", true, [clip]), row("c2", true, null)]),
      "l",
      { signUrl: async () => "u" },
    );
    expect(listed.map((r) => r.conceptId)).toEqual(["c1"]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await loadLearnerSignClips(client([], { message: "boom" }), "l")).toEqual([]);
  });

  it("turns rows into a map by concept", () => {
    expect(
      toClipMap([{ conceptId: "c1", gloss: "G", url: "u", license: "L", signerCredit: null }]),
    ).toEqual({
      c1: { gloss: "G", url: "u", license: "L", signerCredit: null },
    });
  });
});

beforeEach(() => {
  vi.restoreAllMocks();
});
