// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NeedsBox, ParseError, type ParseFn } from "@/components/NeedsBox";
import { announce, LiveRegions } from "@/lib/a11y/live-region";
import { presetProfile } from "@/lib/profile/presets";
import { createProfileStore } from "@/lib/profile/store";
import type { SttHandlers, SttProvider } from "@/lib/speech/stt";
import { expectNoAxeViolations } from "../a11y";

vi.mock("@/lib/a11y/live-region", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/a11y/live-region")>();
  return { ...original, announce: vi.fn(original.announce) };
});

const cardsResponse = {
  ok: true as const,
  profile: {
    ...presetProfile("standard"),
    layout: "cards" as const,
    quiz: { ...presetProfile("standard").quiz, cadence: 2 },
    preset: "custom" as const,
  },
  changes: ["Showing the lesson as cards", "A quiz after every 2 ideas"],
  explanation: "I switched to cards with a quiz every 2 concepts.",
  unsupported: [] as string[],
};

const okParse = (): ParseFn => vi.fn(async () => cardsResponse);

function fakeSpeech(supported = true) {
  let handlers: SttHandlers | null = null;
  const provider: SttProvider & { handlers: () => SttHandlers } = {
    supported,
    start: vi.fn((h: SttHandlers) => {
      handlers = h;
    }),
    stop: vi.fn(),
    abort: vi.fn(),
    handlers: () => handlers as SttHandlers,
  };
  return provider;
}

function setup(
  options: { parse?: ParseFn; speech?: SttProvider | null; autoApply?: boolean } = {},
) {
  const profileStore = createProfileStore({ storage: null });
  const parse = options.parse ?? okParse();
  const user = userEvent.setup();
  const view = render(
    <>
      <NeedsBox
        profileStore={profileStore}
        parse={parse}
        speech={options.speech ?? null}
        autoApply={options.autoApply}
      />
      <LiveRegions />
    </>,
  );
  return { user, profileStore, parse, ...view };
}

/** Queries inside the NeedsBox only: the live region repeats announced messages on purpose. */
const box = () => within(screen.getByRole("region", { name: "Tell Prism what you need" }));

const last = () => vi.mocked(announce).mock.calls.at(-1)?.[0];

beforeEach(() => {
  vi.mocked(announce).mockClear();
});

describe("NeedsBox: typing", () => {
  it("has a labelled field, an example, and no question about a diagnosis", () => {
    setup();
    expect(screen.getByLabelText("What would make this easier for you?")).toBeInTheDocument();
    expect(box().getByText(/You do not need to say why/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/diagnos|disabilit|condition/i);
  });

  it("switches to cards with a low cadence when the learner types their need", async () => {
    const { user, profileStore, parse } = setup();
    await user.type(
      screen.getByLabelText("What would make this easier for you?"),
      "one idea at a time and quiz me often",
    );
    await user.click(screen.getByRole("button", { name: "Update my settings" }));
    expect(parse).toHaveBeenCalledWith(
      "one idea at a time and quiz me often",
      expect.objectContaining({ layout: "reader" }),
    );
    await box().findByText("What changed");
    expect(profileStore.getState().profile).toMatchObject({
      layout: "cards",
      quiz: { cadence: 2 },
    });
  });

  it("shows the explanation and the changes in plain language, and announces the explanation", async () => {
    const { user } = setup();
    await user.type(screen.getByLabelText(/easier for you/), "x");
    await user.click(screen.getByRole("button", { name: "Update my settings" }));
    expect(await box().findByText(cardsResponse.explanation)).toBeInTheDocument();
    expect(box().getByText("Showing the lesson as cards")).toBeInTheDocument();
    expect(box().getByText("A quiz after every 2 ideas")).toBeInTheDocument();
    expect(last()).toBe(cardsResponse.explanation);
  });

  it("submits with Ctrl or Cmd Enter-free keyboard use: Tab to the button and press Enter", async () => {
    const { user, parse } = setup();
    await user.type(screen.getByLabelText(/easier for you/), "bigger text");
    await user.tab();
    expect(screen.getByRole("button", { name: "Update my settings" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it("does not send an empty request, and the button starts disabled", async () => {
    const { user, parse } = setup();
    const button = screen.getByRole("button", { name: "Update my settings" });
    expect(button).toBeDisabled();
    await user.type(screen.getByLabelText(/easier for you/), "   ");
    expect(button).toBeDisabled();
    expect(parse).not.toHaveBeenCalled();
  });

  it("shows that it is working and cannot be submitted twice", async () => {
    let release: (v: typeof cardsResponse) => void = () => {};
    const parse = vi.fn(() => new Promise<typeof cardsResponse>((r) => (release = r)));
    const { user } = setup({ parse });
    await user.type(screen.getByLabelText(/easier for you/), "x");
    await user.click(screen.getByRole("button", { name: "Update my settings" }));
    expect(screen.getByRole("button", { name: "Updating…" })).toBeDisabled();
    await user.keyboard("{Enter}");
    expect(parse).toHaveBeenCalledTimes(1);
    release(cardsResponse);
    await box().findByText("What changed");
  });
});

describe("NeedsBox: undo", () => {
  it("undoes the change and says so", async () => {
    const { user, profileStore } = setup();
    await user.type(screen.getByLabelText(/easier for you/), "x");
    await user.click(screen.getByRole("button", { name: "Update my settings" }));
    await user.click(await screen.findByRole("button", { name: "Undo" }));
    expect(profileStore.getState().profile.layout).toBe("reader");
    expect(box().queryByText("Undone. Your settings are back as they were.")).toBeInTheDocument();
    expect(last()).toBe("Undone. Your settings are back as they were.");
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
  });

  it("has no Undo when nothing changed", async () => {
    const parse: ParseFn = vi.fn(async () => ({
      ok: true as const,
      profile: presetProfile("standard"),
      changes: [],
      explanation: "I could not find a setting for that, so nothing changed.",
      unsupported: ["a hologram"],
    }));
    const { user } = setup({ parse });
    await user.type(screen.getByLabelText(/easier for you/), "hologram");
    await user.click(screen.getByRole("button", { name: "Update my settings" }));
    await box().findByText(/nothing changed/);
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
  });
});

describe("NeedsBox: requests Prism cannot meet", () => {
  it("says so plainly and notes that it was recorded", async () => {
    const parse: ParseFn = vi.fn(async () => ({
      ...cardsResponse,
      unsupported: ["make the text sing"],
    }));
    const { user } = setup({ parse });
    await user.type(screen.getByLabelText(/easier for you/), "x");
    await user.click(screen.getByRole("button", { name: "Update my settings" }));
    expect(await box().findByText(/I cannot do this yet: make the text sing/)).toBeInTheDocument();
  });

  it("shows a rejected change as an alert and leaves the profile unchanged", async () => {
    const parse: ParseFn = vi.fn(async () => ({
      ok: false as const,
      message:
        "I could not make that change safely, so your settings are unchanged. Try describing it another way.",
      unsupported: [],
    }));
    const { user, profileStore } = setup({ parse });
    const before = profileStore.getState().profile;
    await user.type(screen.getByLabelText(/easier for you/), "x");
    await user.click(screen.getByRole("button", { name: "Update my settings" }));
    const alert = await box().findByText(/your settings are unchanged/);
    expect(alert.closest("[role=alert]")).not.toBeNull();
    expect(profileStore.getState().profile).toBe(before);
  });
});

describe("NeedsBox: errors", () => {
  it("shows a network failure as an alert and lets the learner try again", async () => {
    const parse: ParseFn = vi
      .fn<ParseFn>()
      .mockRejectedValueOnce(new Error("We could not update your settings. Please try again."))
      .mockResolvedValueOnce(cardsResponse);
    const { user } = setup({ parse });
    await user.type(screen.getByLabelText(/easier for you/), "x");
    await user.click(screen.getByRole("button", { name: "Update my settings" }));
    await box().findByText(/could not update your settings/);
    expect(screen.getByLabelText(/easier for you/)).toHaveValue("x"); // their words are kept
    await user.click(screen.getByRole("button", { name: "Update my settings" }));
    await box().findByText("What changed");
  });

  it("explains a rate limit", async () => {
    const parse: ParseFn = vi.fn(async () => {
      throw new ParseError("That was a lot of requests. Please wait a moment and try again.", 30);
    });
    const { user } = setup({ parse });
    await user.type(screen.getByLabelText(/easier for you/), "x");
    await user.click(screen.getByRole("button", { name: "Update my settings" }));
    expect(await box().findByText(/lot of requests/)).toBeInTheDocument();
    expect(last()).toMatch(/lot of requests/);
  });
});

describe("NeedsBox: review before applying", () => {
  it("shows what would change with Apply and Not now, and changes nothing until Apply", async () => {
    const { user, profileStore } = setup({ autoApply: false });
    await user.type(screen.getByLabelText(/easier for you/), "x");
    await user.click(screen.getByRole("button", { name: "Update my settings" }));
    await box().findByText("What would change");
    expect(profileStore.getState().profile.layout).toBe("reader");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(profileStore.getState().profile.layout).toBe("cards");
    expect(await screen.findByRole("button", { name: "Undo" })).toBeInTheDocument();
    expect(last()).toBe("Applied.");
  });

  it("lets the learner decline", async () => {
    const { user, profileStore } = setup({ autoApply: false });
    await user.type(screen.getByLabelText(/easier for you/), "x");
    await user.click(screen.getByRole("button", { name: "Update my settings" }));
    await user.click(await screen.findByRole("button", { name: "Not now" }));
    expect(profileStore.getState().profile.layout).toBe("reader");
    expect(box().queryByText("What would change")).not.toBeInTheDocument();
  });
});

describe("NeedsBox: speaking", () => {
  it("hides the microphone when speech is not supported, and typing still works", async () => {
    const { user, parse } = setup({ speech: fakeSpeech(false) });
    expect(screen.queryByRole("button", { name: /Speak instead/ })).not.toBeInTheDocument();
    await user.type(screen.getByLabelText(/easier for you/), "x");
    await user.click(screen.getByRole("button", { name: "Update my settings" }));
    expect(parse).toHaveBeenCalled();
  });

  it("offers no microphone when speech is turned off", () => {
    setup({ speech: null });
    expect(screen.queryByRole("button", { name: /Speak instead/ })).not.toBeInTheDocument();
  });

  it("listens, shows live text, and sends the finished sentence", async () => {
    const speech = fakeSpeech();
    const { user, parse, profileStore } = setup({ speech });
    await user.click(screen.getByRole("button", { name: "Speak instead" }));
    expect(speech.start).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Stop listening" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(vi.mocked(announce).mock.calls.some(([m]) => m === "Listening.")).toBe(true);

    speech.handlers().onPartial("quiz me");
    await waitFor(() => expect(screen.getByLabelText(/easier for you/)).toHaveValue("quiz me"));
    speech.handlers().onFinal("quiz me often");
    speech.handlers().onEnd();
    await waitFor(() => expect(parse).toHaveBeenCalledWith("quiz me often", expect.anything()));
    await box().findByText("What changed");
    expect(profileStore.getState().profile.layout).toBe("cards");
    expect(screen.getByRole("button", { name: "Speak instead" })).toBeInTheDocument();
  });

  it("stops listening when asked", async () => {
    const speech = fakeSpeech();
    const { user } = setup({ speech });
    await user.click(screen.getByRole("button", { name: "Speak instead" }));
    await user.click(screen.getByRole("button", { name: "Stop listening" }));
    expect(speech.stop).toHaveBeenCalledTimes(1);
  });

  it("explains a microphone problem and points to typing", async () => {
    const speech = fakeSpeech();
    const { user } = setup({ speech });
    await user.click(screen.getByRole("button", { name: "Speak instead" }));
    speech.handlers().onError("permission_denied");
    speech.handlers().onEnd();
    expect(await box().findByText(/Prism cannot use your microphone/)).toBeInTheDocument();
    expect(last()).toMatch(/type instead/);
  });

  it("does not show an error for a deliberate stop", async () => {
    const speech = fakeSpeech();
    const { user } = setup({ speech });
    await user.click(screen.getByRole("button", { name: "Speak instead" }));
    speech.handlers().onError("aborted");
    speech.handlers().onEnd();
    expect(box().queryByText(/Listening was stopped/)).not.toBeInTheDocument();
  });

  it("stops listening when the box is removed", async () => {
    const speech = fakeSpeech();
    const { user, unmount } = setup({ speech });
    await user.click(screen.getByRole("button", { name: "Speak instead" }));
    unmount();
    expect(speech.abort).toHaveBeenCalled();
  });
});

describe("NeedsBox: accessibility", () => {
  it("has no axe violations at rest, with a result, and with the microphone", async () => {
    const user = userEvent.setup();
    const { container } = setup({ speech: fakeSpeech() });
    await expectNoAxeViolations(container, { rules: ["landmark-unique"] });
    await user.type(screen.getByLabelText(/easier for you/), "x");
    await user.click(screen.getByRole("button", { name: "Update my settings" }));
    await box().findByText("What changed");
    await expectNoAxeViolations(container, { rules: ["landmark-unique"] });
  });

  it("keeps the results region from announcing twice: it relies on the live region", async () => {
    const { user } = setup();
    await user.type(screen.getByLabelText(/easier for you/), "x");
    await user.click(screen.getByRole("button", { name: "Update my settings" }));
    const result = (await box().findByText("What changed")).closest("div[aria-live]");
    expect(result?.getAttribute("aria-live")).toBe("off");
    expect(within(result as HTMLElement).queryAllByRole("alert")).toHaveLength(0);
  });
});
