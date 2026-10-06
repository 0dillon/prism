// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewTabs } from "@/app/teach/lessons/[id]/review/ReviewTabs";
import { SignsPanel, type SignCall } from "@/app/teach/lessons/[id]/review/SignsPanel";
import { announce, LiveRegions } from "@/lib/a11y/live-region";
import type { SignReviewItem } from "@/lib/lessons/sign-service";
import { expectNoAxeViolations } from "../a11y";

vi.mock("@/lib/a11y/live-region", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/a11y/live-region")>();
  return { ...original, announce: vi.fn(original.announce) };
});

const concepts = [
  { id: "c_evap", title: "Evaporation", keyTerm: "evaporation" },
  { id: "c_rain", title: "Precipitation", keyTerm: "precipitation" },
];

const item = (
  conceptId: string,
  gloss: string,
  extra: Partial<SignReviewItem> = {},
): SignReviewItem => ({
  conceptId,
  verified: false,
  gloss,
  license: "CC-BY-4.0",
  signerCredit: "A. Signer",
  clipUrl: `https://signed.test/${gloss}.mp4`,
  ...extra,
});

const okCall = (): SignCall => vi.fn(async () => {});

function setup(
  items = [item("c_evap", "EVAPORATE"), item("c_rain", "RAIN", { verified: true })],
  call = okCall(),
) {
  const user = userEvent.setup();
  const view = render(
    <>
      <SignsPanel lessonId="lesson-1" items={items} concepts={concepts} call={call} />
      <LiveRegions />
    </>,
  );
  return { user, call, ...view };
}

const last = () => vi.mocked(announce).mock.calls.at(-1)?.[0];

beforeEach(() => {
  vi.mocked(announce).mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("SignsPanel", () => {
  it("shows each proposed sign with its concept, key term, gloss and status", () => {
    setup();
    const evap = screen.getByRole("article", { name: "Evaporation" });
    expect(within(evap).getByText("EVAPORATE")).toBeInTheDocument();
    expect(
      within(evap).getByText(/Needs checking\. Learners cannot see it yet\./),
    ).toBeInTheDocument();
    const rain = screen.getByRole("article", { name: "Precipitation" });
    expect(within(rain).getByText(/Verified\. Learners can see this sign\./)).toBeInTheDocument();
    expect(screen.getByText("2 proposed signs, 1 to verify.")).toBeInTheDocument();
  });

  it("plays each clip in a labelled video with controls, and never autoplays", () => {
    setup();
    const video = screen.getByLabelText("Sign for EVAPORATE") as HTMLVideoElement;
    expect(video.tagName).toBe("VIDEO");
    expect(video).toHaveAttribute("controls");
    expect(video.autoplay).toBe(false);
    expect(video).toHaveAttribute("src", "https://signed.test/EVAPORATE.mp4");
  });

  it("says plainly that signs are for key terms and not a full translation", () => {
    setup();
    expect(screen.getByText(/This is not a full translation/)).toBeInTheDocument();
    expect(screen.getByText(/fluent signer confirm/)).toBeInTheDocument();
  });

  it("verifies a sign, updates its status and announces it", async () => {
    const { user, call } = setup();
    await user.click(screen.getByRole("button", { name: "Verify the sign for Evaporation" }));
    expect(call).toHaveBeenCalledWith("lesson-1", { conceptId: "c_evap", action: "verify" });
    await screen.findByText("2 proposed signs, all verified.");
    expect(last()).toBe("Verified the sign for Evaporation.");
    expect(
      screen.getByRole("button", { name: "Un-verify the sign for Evaporation" }),
    ).toBeInTheDocument();
  });

  it("un-verifies a verified sign", async () => {
    const { user, call } = setup();
    await user.click(screen.getByRole("button", { name: "Un-verify the sign for Precipitation" }));
    expect(call).toHaveBeenCalledWith("lesson-1", { conceptId: "c_rain", action: "unverify" });
    await screen.findByText("2 proposed signs, 2 to verify.");
  });

  it("removes a sign only after confirmation", async () => {
    const { user, call } = setup();
    await user.click(screen.getByRole("button", { name: "Remove the sign for Evaporation" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Remove this sign?" });
    expect(
      within(dialog).getByText(/fingerspelled instead of the EVAPORATE sign/),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(call).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Remove the sign for Evaporation" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remove sign" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("article", { name: "Evaporation" })).not.toBeInTheDocument(),
    );
    expect(call).toHaveBeenCalledWith("lesson-1", { conceptId: "c_evap", action: "remove" });
    expect(last()).toBe("Removed the sign for Evaporation.");
  });

  it("keeps the status unchanged and shows an alert when an update fails", async () => {
    const call: SignCall = vi.fn(async () => {
      throw new Error("We could not update that sign. Please try again.");
    });
    const { user } = setup(undefined, call);
    await user.click(screen.getByRole("button", { name: "Verify the sign for Evaporation" }));
    expect(
      await screen.findByText(/could not update that sign/, { selector: "span" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Needs checking/)).toBeInTheDocument();
    expect(last()).toMatch(/^Not updated\./);
  });

  it("explains when a clip cannot be loaded", () => {
    setup([item("c_evap", "EVAPORATE", { clipUrl: null })]);
    expect(screen.getByText("The clip could not be loaded right now.")).toBeInTheDocument();
  });

  it("explains fingerspelling when no signs were matched", () => {
    setup([]);
    expect(screen.getByText(/Every key term will be shown\s+fingerspelled/)).toBeInTheDocument();
  });

  it("ignores a link for a concept that is no longer in the lesson", () => {
    setup([item("c_gone", "GONE"), item("c_evap", "EVAPORATE")]);
    expect(screen.getAllByRole("article")).toHaveLength(1);
  });

  it("has no axe violations, including with a dialog open", async () => {
    const { user, container } = setup();
    await expectNoAxeViolations(container, { rules: ["landmark-unique"] });
    await user.click(screen.getByRole("button", { name: "Remove the sign for Evaporation" }));
    await screen.findByRole("alertdialog");
    await expectNoAxeViolations(document.body, { rules: ["landmark-unique"] });
  });
});

describe("ReviewTabs", () => {
  const tabs = () =>
    render(
      <ReviewTabs
        signCount={2}
        concepts={<input aria-label="Draft title" />}
        signs={<p>Sign review</p>}
      />,
    );

  it("shows the concepts tab first and counts the signs", () => {
    tabs();
    expect(screen.getByRole("tab", { name: "Concepts and questions" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: "Signs (2)" })).toBeInTheDocument();
    expect(screen.getByLabelText("Draft title")).toBeVisible();
  });

  it("keeps unsaved edits when switching tabs back and forth", async () => {
    const user = userEvent.setup();
    tabs();
    await user.type(screen.getByLabelText("Draft title"), "half-typed");
    await user.click(screen.getByRole("tab", { name: "Signs (2)" }));
    expect(screen.getByText("Sign review")).toBeVisible();
    // The editor stays mounted; the stylesheet hides it (checked in the browser tests).
    const editorPanel = screen
      .getByLabelText("Draft title", { selector: "input" })
      .closest("[role=tabpanel]");
    expect(editorPanel).toHaveAttribute("data-state", "inactive");
    await user.click(screen.getByRole("tab", { name: "Concepts and questions" }));
    expect(screen.getByLabelText("Draft title")).toHaveValue("half-typed");
  });

  it("can be switched with the arrow keys", async () => {
    const user = userEvent.setup();
    tabs();
    screen.getByRole("tab", { name: "Concepts and questions" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Signs (2)" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "Signs (2)" })).toHaveAttribute("aria-selected", "true");
  });
});
