// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DemoPlayer } from "@/app/demo/DemoPlayer";
import { announce, LiveRegions } from "@/lib/a11y/live-region";
import { expectNoAxeViolations } from "../a11y";

vi.mock("@/lib/a11y/live-region", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/a11y/live-region")>();
  return { ...original, announce: vi.fn(original.announce) };
});

function setup() {
  const user = userEvent.setup();
  const view = render(
    <>
      <DemoPlayer />
      <LiveRegions />
    </>,
  );
  return { user, ...view };
}

const learnerButton = (name: string) =>
  screen.getByRole("button", { name: new RegExp(`^${name}`) });

beforeEach(() => {
  window.localStorage.clear();
  vi.mocked(announce).mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("the demo must not use the network");
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DemoPlayer", () => {
  it("opens on the first learner's own layout, with their lesson ready to start", async () => {
    setup();
    expect(
      await screen.findByRole("heading", { level: 1, name: /The Water Cycle, cards view/ }),
    ).toBeInTheDocument();
    expect(learnerButton("Maya")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(/Showing Maya, who likes: one idea at a time/)).toBeInTheDocument();
  });

  it("says plainly that it is a sample and where progress is kept", async () => {
    setup();
    await screen.findByRole("heading", { level: 1 });
    expect(screen.getByText(/This is a sample lesson/)).toBeInTheDocument();
    expect(screen.getByText(/saved in this browser only/)).toBeInTheDocument();
  });

  it("offers every learner as a toggle button, and exactly one is pressed", async () => {
    setup();
    await screen.findByRole("heading", { level: 1 });
    const group = screen.getByRole("group", { name: "Learner" });
    const buttons = within(group).getAllByRole("button");
    expect(buttons.map((b) => b.textContent?.replace(" (current)", ""))).toEqual([
      "Maya",
      "Tunde",
      "Leo",
      "Sofia",
    ]);
    expect(buttons.filter((b) => b.getAttribute("aria-pressed") === "true")).toHaveLength(1);
  });

  it("switches to another learner's layout and says who is showing", async () => {
    const { user } = setup();
    await screen.findByRole("heading", { level: 1, name: /cards view/ });
    await user.click(learnerButton("Leo"));
    expect(
      await screen.findByRole("heading", { level: 1, name: /reading view/ }),
    ).toBeInTheDocument();
    expect(learnerButton("Leo")).toHaveAttribute("aria-pressed", "true");
    expect(learnerButton("Maya")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText(/Showing Leo, who likes: easy reading/)).toBeInTheDocument();
    expect(vi.mocked(announce)).toHaveBeenCalledWith("Showing the lesson as Leo.");
  });

  it("moves focus to the status line after a switch, so focus is not left on a changed control", async () => {
    const { user } = setup();
    await screen.findByRole("heading", { level: 1 });
    await user.click(learnerButton("Sofia"));
    expect(screen.getByText(/Showing Sofia/)).toHaveFocus();
  });

  it("keeps each learner's place when switching away and back", async () => {
    const { user } = setup();
    await user.click(await screen.findByRole("button", { name: "Start" }));
    await user.click(await screen.findByRole("button", { name: "Next" }));
    expect(
      await screen.findByRole("heading", { level: 2, name: "Transpiration" }),
    ).toBeInTheDocument();

    await user.click(learnerButton("Leo"));
    expect(await screen.findByRole("button", { name: "Start" })).toBeInTheDocument(); // Leo has not started

    await user.click(learnerButton("Maya"));
    expect(
      await screen.findByRole("heading", { level: 2, name: "Transpiration" }),
    ).toBeInTheDocument();
  });

  it("keeps a learner's place after a reload", async () => {
    const first = setup();
    await first.user.click(await screen.findByRole("button", { name: "Start" }));
    await first.user.click(await screen.findByRole("button", { name: "Next" }));
    first.unmount();
    setup();
    expect(
      await screen.findByRole("heading", { level: 2, name: "Transpiration" }),
    ).toBeInTheDocument();
  });

  it("starts a learner over", async () => {
    const { user } = setup();
    await user.click(await screen.findByRole("button", { name: "Start" }));
    await user.click(await screen.findByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Start Maya over" }));
    expect(await screen.findByRole("button", { name: "Start" })).toBeInTheDocument();
    expect(vi.mocked(announce)).toHaveBeenCalledWith("Maya has started over.");
  });

  it("opens Settings for the current learner and changes only theirs", async () => {
    const { user } = setup();
    await screen.findByRole("heading", { level: 1 });
    await user.click(screen.getByRole("button", { name: "Settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    await user.click(within(dialog).getByRole("checkbox", { name: "Show my streak" }));
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    await user.click(learnerButton("Tunde"));
    await screen.findByRole("heading", { level: 1, name: /conversation view/ });
    await user.click(screen.getByRole("button", { name: "Settings" }));
    const other = await screen.findByRole("dialog", { name: "Settings" });
    expect(within(other).getByRole("checkbox", { name: "Show my streak" })).not.toBeChecked();
  });

  it("offers the needs box", async () => {
    setup();
    await screen.findByRole("heading", { level: 1 });
    expect(screen.getByRole("heading", { name: "Tell Prism what you need" })).toBeInTheDocument();
  });

  it("serves a simpler wording with no network, from the page's own text", async () => {
    const { user } = setup();
    await user.click(learnerButton("Leo")); // easy reading: plainer wording by default
    await user.click(await screen.findByRole("button", { name: "Start" }));
    await waitFor(() =>
      expect(
        screen.getByText(/The sun heats water in oceans, lakes, and rivers/),
      ).toBeInTheDocument(),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("has no axe violations", async () => {
    const { container, user } = setup();
    await screen.findByRole("heading", { level: 1 });
    await expectNoAxeViolations(container, { rules: ["landmark-unique", "heading-order"] });
    await user.click(learnerButton("Leo"));
    await screen.findByRole("heading", { level: 1, name: /reading view/ });
    await expectNoAxeViolations(container, { rules: ["landmark-unique", "heading-order"] });
    await act(async () => {});
  });
});
