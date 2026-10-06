// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingFlow } from "@/app/onboarding/OnboardingFlow";
import { PresetGallery } from "@/components/PresetGallery";
import { ProfilePreview } from "@/components/ProfilePreview";
import { announce, LiveRegions } from "@/lib/a11y/live-region";
import { presetProfile } from "@/lib/profile/presets";
import { createProfileStore } from "@/lib/profile/store";
import { expectNoAxeViolations } from "../a11y";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/a11y/live-region", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/a11y/live-region")>();
  return { ...original, announce: vi.fn(original.announce) };
});

function setup(next = "/learn") {
  const profileStore = createProfileStore({ storage: null });
  const navigate = vi.fn();
  const user = userEvent.setup();
  const view = render(
    <>
      <OnboardingFlow next={next} profileStore={profileStore} navigate={navigate} speech={null} />
      <LiveRegions />
    </>,
  );
  return { user, profileStore, navigate, ...view };
}

const last = () => vi.mocked(announce).mock.calls.at(-1)?.[0];
const preview = () => screen.getByRole("region", { name: "Preview" });

beforeEach(() => {
  vi.mocked(announce).mockClear();
});

describe("onboarding: choosing a preset", () => {
  it("offers every preset with a plain description", () => {
    setup();
    for (const label of [
      "Standard",
      "Talk it through",
      "One idea at a time",
      "Easy reading",
      "Pictures and signs",
    ]) {
      expect(screen.getByRole("button", { name: new RegExp(label) })).toBeInTheDocument();
    }
    expect(screen.getByText(/Roomy spacing, plainer wording/)).toBeInTheDocument();
  });

  it("marks the current choice as pressed and starts on Standard", () => {
    setup();
    expect(screen.getByRole("button", { name: /Standard/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: /One idea at a time/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("applies the preset and updates the preview at once, with no request", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { user, profileStore } = setup();
    await user.click(screen.getByRole("button", { name: /Easy reading/ }));
    expect(profileStore.getState().profile.preset).toBe("cognitive_ease");
    expect(preview()).toHaveAttribute("data-theme", "cream");
    expect(preview()).toHaveAttribute("data-font", "lexend");
    expect(preview().style.getPropertyValue("--line-height")).toBe("1.8");
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("announces the choice and that the preview changed", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: /One idea at a time/ }));
    expect(last()).toBe("One idea at a time selected. The preview has updated.");
  });

  it("describes the layout in the preview for each preset", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: /Talk it through/ }));
    expect(
      within(preview()).getByText(/Prism will talk you through the lesson/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Pictures and signs/ }));
    expect(within(preview()).getByText(/captions, and sign clips/)).toBeInTheDocument();
  });

  it("lets the learner change their mind", async () => {
    const { user, profileStore } = setup();
    await user.click(screen.getByRole("button", { name: /One idea at a time/ }));
    await user.click(screen.getByRole("button", { name: /Standard/ }));
    expect(profileStore.getState().profile.layout).toBe("reader");
  });
});

describe("onboarding: keyboard and screen reader", () => {
  it("can be completed by keyboard alone", async () => {
    const { user, profileStore, navigate } = setup("/learn");
    await user.tab();
    expect(screen.getByRole("button", { name: /Standard/ })).toHaveFocus();
    await user.tab(); // Talk it through
    await user.tab(); // One idea at a time
    await user.keyboard("{Enter}");
    expect(profileStore.getState().profile.preset).toBe("hyper_focus");
    // Tab on to Continue: past the remaining presets, the needs box, and its buttons.
    const continueButton = screen.getByRole("button", { name: "Continue" });
    for (let i = 0; i < 12 && document.activeElement !== continueButton; i++) await user.tab();
    expect(continueButton).toHaveFocus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/learn"));
  });

  it("reads each preset's description with its button", () => {
    setup();
    const button = screen.getByRole("button", { name: /Easy reading/ });
    expect(button).toHaveAccessibleDescription(/Roomy spacing/);
  });

  it("says which preset is selected in words, not only with a mark", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: /Easy reading/ }));
    expect(screen.getByRole("button", { name: /Easy reading \(selected\)/ })).toBeInTheDocument();
  });

  it("has a labelled group for the choices and a named preview region", () => {
    setup();
    expect(screen.getByRole("group", { name: "Pick a starting point" })).toBeInTheDocument();
    expect(preview()).toBeInTheDocument();
  });

  it("has no axe violations at rest and after choosing a preset", async () => {
    const { user, container } = setup();
    await expectNoAxeViolations(container, { rules: ["landmark-unique"] });
    await user.click(screen.getByRole("button", { name: /Easy reading/ }));
    await expectNoAxeViolations(container, { rules: ["landmark-unique"] });
  });
});

describe("onboarding: no diagnosis, ever", () => {
  it("never asks about or names a condition anywhere on the page", () => {
    setup();
    expect(document.body.textContent).not.toMatch(
      /diagnos|disabilit|condition|adhd|dyslex|autis|blind|deaf/i,
    );
  });

  it("says plainly that it will not ask why", () => {
    setup();
    expect(screen.getByText(/You do not need to say why/)).toBeInTheDocument();
  });
});

describe("onboarding: finishing", () => {
  it("saves the profile before moving on, then goes where it was asked", async () => {
    const save = vi.fn(async () => {});
    const profileStore = createProfileStore({ storage: null, save });
    profileStore.getState().hydrate();
    const navigate = vi.fn();
    const user = userEvent.setup();
    render(
      <OnboardingFlow
        next="/teach/upload"
        profileStore={profileStore}
        navigate={navigate}
        speech={null}
      />,
    );
    await user.click(screen.getByRole("button", { name: /One idea at a time/ }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/teach/upload"));
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(navigate.mock.invocationCallOrder[0]);
  });

  it("cannot be pressed twice", async () => {
    const { user, navigate } = setup();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
  });

  it("still continues if the save fails: the profile is on the device", async () => {
    const save = vi.fn(async () => {
      throw new Error("offline");
    });
    const profileStore = createProfileStore({ storage: null, save });
    profileStore.getState().hydrate();
    const navigate = vi.fn();
    const user = userEvent.setup();
    render(
      <OnboardingFlow
        next="/learn"
        profileStore={profileStore}
        navigate={navigate}
        speech={null}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/learn"));
  });
});

describe("PresetGallery and ProfilePreview on their own", () => {
  it("shows a custom profile with no preset selected and a way back", () => {
    render(<PresetGallery profile={presetProfile("custom")} onSelect={vi.fn()} />);
    expect(screen.getByText(/You are using your own settings/)).toBeInTheDocument();
    expect(
      screen.getAllByRole("button").some((b) => b.getAttribute("aria-pressed") === "true"),
    ).toBe(false);
  });

  it("previews the learner's own settings, including hiding examples and progress", () => {
    const profile = presetProfile("standard");
    profile.content.showExamples = false;
    profile.feedback.progressBar = false;
    render(<ProfilePreview profile={profile} />);
    expect(screen.queryByText(/For example, a puddle/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Progress: 1 of 5/)).not.toBeInTheDocument();
  });

  it("keeps the sample from being interactive", () => {
    render(<ProfilePreview profile={presetProfile("standard")} />);
    expect(within(preview()).queryAllByRole("button")).toHaveLength(0);
  });

  it("updates when the profile changes", () => {
    const store = createProfileStore({ storage: null });
    const { rerender } = render(<ProfilePreview profile={store.getState().profile} />);
    act(() => store.getState().applyPreset("cognitive_ease"));
    rerender(<ProfilePreview profile={store.getState().profile} />);
    expect(preview()).toHaveAttribute("data-theme", "cream");
  });
});
