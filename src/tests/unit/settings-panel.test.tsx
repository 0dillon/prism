// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { SettingsPanel } from "@/components/SettingsPanel";
import { LiveRegions } from "@/lib/a11y/live-region";
import { createProfileStore } from "@/lib/profile/store";
import { RenderProfile } from "@/lib/schemas/render-profile";
import { expectNoAxeViolations } from "../a11y";

function setup(open = true) {
  const profileStore = createProfileStore({ storage: null });
  const user = userEvent.setup();
  const view = render(
    <>
      <SettingsPanel profileStore={profileStore} defaultOpen={open} />
      <LiveRegions />
    </>,
  );
  return { user, profileStore, ...view };
}

const dialog = () => screen.getByRole("dialog", { name: "Settings" });
const control = (path: string) => {
  const el = dialog().querySelector<HTMLElement>(`[data-setting="${path}"]`);
  if (!el) throw new Error(`No control for ${path}`);
  return el as HTMLInputElement | HTMLSelectElement;
};

/** Every setting in the schema, as "group.key", plus the top-level layout. */
function schemaPaths(): string[] {
  const paths: string[] = [];
  for (const [key, field] of Object.entries(RenderProfile.shape)) {
    if (key === "schemaVersion" || key === "preset") continue;
    const shape = (field as { shape?: Record<string, unknown> }).shape;
    if (shape) for (const inner of Object.keys(shape)) paths.push(`${key}.${inner}`);
    else paths.push(key);
  }
  return paths;
}

describe("settings panel: completeness", () => {
  it("finds the schema's settings, so this check cannot pass by checking nothing", () => {
    const paths = schemaPaths();
    expect(paths.length).toBeGreaterThan(25);
    expect(paths).toContain("layout");
    expect(paths).toContain("typography.sizeScale");
  });

  it("has a control for every setting in the Render Profile", () => {
    setup();
    for (const path of schemaPaths()) expect(control(path), path).toBeInTheDocument();
  });

  it("has no control for a setting the schema does not have", () => {
    setup();
    const known = new Set(schemaPaths());
    for (const el of dialog().querySelectorAll("[data-setting]")) {
      expect(known.has(el.getAttribute("data-setting")!), el.getAttribute("data-setting")!).toBe(
        true,
      );
    }
  });

  it("gives every control a label a person can read", () => {
    setup();
    for (const path of schemaPaths()) {
      const el = control(path);
      expect(el.labels?.length, path).toBeGreaterThan(0);
      expect(el.labels![0].textContent?.trim().length, path).toBeGreaterThan(2);
    }
  });

  it("offers exactly the values the schema allows for every choice", () => {
    setup();
    const groups = RenderProfile.shape;
    const enums: Record<string, readonly string[]> = {
      layout: groups.layout.options,
      "content.readingLevel": groups.content.shape.readingLevel.unwrap().options,
      "content.chunkSize": groups.content.shape.chunkSize.unwrap().options,
      "typography.font": groups.typography.shape.font.unwrap().options,
      "audio.syncHighlight": groups.audio.shape.syncHighlight.unwrap().options,
      "visual.theme": groups.visual.shape.theme.unwrap().options,
      "visual.signLanguage": groups.visual.shape.signLanguage.unwrap().options,
      "feedback.celebration": groups.feedback.shape.celebration.unwrap().options,
    };
    for (const [path, expected] of Object.entries(enums)) {
      const values = [...(control(path) as HTMLSelectElement).options].map((o) => o.value);
      expect(values.sort(), path).toEqual([...expected].sort());
    }
  });

  it("keeps every slider's range inside what the schema accepts", () => {
    const { profileStore } = setup();
    const sliders = [...dialog().querySelectorAll<HTMLInputElement>('input[type="range"]')];
    expect(sliders.length).toBe(8);
    for (const slider of sliders) {
      for (const extreme of [slider.min, slider.max]) {
        fireEvent.change(slider, { target: { value: extreme } });
        expect(RenderProfile.safeParse(profileStore.getState().profile).success).toBe(true);
      }
    }
  });
});

describe("settings panel: changing things", () => {
  it("applies a checkbox at once and shows it as checked", async () => {
    const { user, profileStore } = setup();
    await user.click(screen.getByRole("checkbox", { name: "Read the lesson aloud" }));
    expect(profileStore.getState().profile.audio.readAloud).toBe(true);
    expect(screen.getByRole("checkbox", { name: "Read the lesson aloud" })).toBeChecked();
  });

  it("applies a select at once", async () => {
    const { user, profileStore } = setup();
    await user.selectOptions(screen.getByLabelText("Font"), "lexend");
    expect(profileStore.getState().profile.typography.font).toBe("lexend");
  });

  it("changes the layout", async () => {
    const { user, profileStore } = setup();
    await user.selectOptions(screen.getByLabelText("Layout"), "cards");
    expect(profileStore.getState().profile.layout).toBe("cards");
  });

  it("applies a slider as a number, and says its value in words", () => {
    const { profileStore } = setup();
    const slider = control("typography.sizeScale") as HTMLInputElement;
    fireEvent.change(slider, { target: { value: "1.5" } });
    expect(profileStore.getState().profile.typography.sizeScale).toBe(1.5);
    expect(slider).toHaveAttribute("aria-valuetext", "150%");
    expect(control("quiz.cadence")).toHaveAttribute("aria-valuetext", "5 ideas");
  });

  it("uses native sliders with whole-number steps, so arrow keys work in a browser", () => {
    // jsdom does not move range inputs with the keyboard; browsers do, which is why these
    // are native inputs and not custom widgets.
    setup();
    const slider = control("quiz.cadence") as HTMLInputElement;
    expect(slider.type).toBe("range");
    expect(slider).not.toHaveAttribute("tabindex", "-1");
    expect(slider).toHaveAttribute("step", "1");
    slider.focus();
    expect(slider).toHaveFocus();
  });

  it("marks the profile as the learner's own once they change a setting", async () => {
    const { user, profileStore } = setup();
    await user.click(screen.getByRole("checkbox", { name: "Show my streak" }));
    expect(profileStore.getState().profile.preset).toBe("custom");
    expect(screen.getByText("Your own settings are in use.")).toBeInTheDocument();
  });

  it("undoes a whole slider drag in one step", () => {
    const { profileStore } = setup();
    const slider = control("typography.sizeScale");
    for (const value of ["1.1", "1.2", "1.3", "1.4"])
      fireEvent.change(slider, { target: { value } });
    expect(profileStore.getState().history).toHaveLength(1);
    profileStore.getState().undo();
    expect(profileStore.getState().profile.typography.sizeScale).toBe(1);
  });

  it("switches preset from inside the panel and updates the controls to match", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: /Easy reading/ }));
    expect(control("visual.theme")).toHaveValue("cream");
    expect(control("typography.font")).toHaveValue("lexend");
  });

  it("keeps the sign claim honest", () => {
    setup();
    expect(within(dialog()).getByText(/not a full translation/)).toBeInTheDocument();
  });

  it("does not name any condition", () => {
    setup();
    // OpenDyslexic is the name of a font, so it is allowed. Nothing else may name a condition.
    const text = dialog().textContent!.replaceAll("OpenDyslexic", "");
    expect(text).not.toMatch(/adhd|dyslex|autis|blind|deaf|disabilit/i);
  });
});

describe("settings panel: dialog behaviour", () => {
  it("is closed until asked, and opens from its button", async () => {
    const { user } = setup(false);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(dialog()).toBeInTheDocument();
  });

  it("closes with Escape and returns focus to the button that opened it", async () => {
    const { user } = setup(false);
    const opener = screen.getByRole("button", { name: "Settings" });
    await user.click(opener);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("closes with Done", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps keyboard focus inside while open", async () => {
    const { user } = setup();
    for (let i = 0; i < 80; i++) {
      await user.tab();
      expect(dialog().contains(document.activeElement)).toBe(true);
    }
  });

  it("is grouped so a screen reader hears where each setting belongs", () => {
    setup();
    for (const name of ["Layout", "Content", "Quiz", "Text", "Audio", "Visual", "Feedback"]) {
      expect(within(dialog()).getByRole("group", { name })).toBeInTheDocument();
    }
  });

  it("has no axe violations", async () => {
    setup();
    await expectNoAxeViolations(dialog());
  });

  it("makes every control big enough to hit", () => {
    setup();
    for (const el of dialog().querySelectorAll('input[type="checkbox"]')) {
      expect(el.className).toContain("size-6");
    }
    for (const el of dialog().querySelectorAll('input[type="range"]')) {
      expect(el.className).toContain("h-11");
    }
  });
});
