// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { announce } from "@/lib/a11y/live-region";
import { presetProfile } from "@/lib/profile/presets";
import { ProfileSwitcher } from "@/renderers/shared/ProfileSwitcher";
import { ProgressBar } from "@/renderers/shared/ProgressBar";
import { QuizBlock, type QuizBlockProps } from "@/renderers/shared/QuizBlock";
import type { QuizItem } from "@/lib/schemas/knowledge-graph";
import { expectNoAxeViolations } from "../a11y";
import { makeGraph } from "../fixtures/graph";

vi.mock("@/lib/a11y/live-region", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/a11y/live-region")>();
  return { ...original, announce: vi.fn(original.announce) };
});

const [mcq, trueFalse, , short] = makeGraph().quizItems;

/** Drives QuizBlock the way a session would: answering moves it to feedback. */
function Harness({
  item,
  onAnswerSpy,
  onContinueSpy,
  gradeShortAnswer,
}: {
  item: QuizItem;
  onAnswerSpy?: (correct: boolean, value: string) => void;
  onContinueSpy?: () => void;
  gradeShortAnswer?: QuizBlockProps["gradeShortAnswer"];
}) {
  const [answer, setAnswer] = useState<{ quizItemId: string; correct: boolean } | null>(null);
  return (
    <QuizBlock
      item={item}
      phase={answer ? "feedback" : "quiz"}
      lastAnswer={answer}
      gradeShortAnswer={gradeShortAnswer}
      onAnswer={(correct, value) => {
        onAnswerSpy?.(correct, value);
        setAnswer({ quizItemId: item.id, correct });
      }}
      onContinue={() => onContinueSpy?.()}
    />
  );
}

beforeEach(() => {
  vi.mocked(announce).mockClear();
});

describe("QuizBlock: multiple choice", () => {
  it("shows the question and every option as a button", () => {
    render(<Harness item={mcq} />);
    expect(screen.getByText(mcq.prompt)).toBeInTheDocument();
    for (const option of mcq.options ?? []) {
      expect(screen.getByRole("button", { name: option })).toBeInTheDocument();
    }
  });

  it("grades a correct answer locally and reports it", async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<Harness item={mcq} onAnswerSpy={spy} />);
    await user.click(screen.getByRole("button", { name: mcq.answer }));
    expect(spy).toHaveBeenCalledWith(true, mcq.answer);
  });

  it("grades a wrong answer locally and shows the right one", async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<Harness item={mcq} onAnswerSpy={spy} />);
    await user.click(screen.getByRole("button", { name: "It turns into ice" }));
    expect(spy).toHaveBeenCalledWith(false, "It turns into ice");
    expect(screen.getByText(`Not quite. The answer is ${mcq.answer}.`)).toBeInTheDocument();
    expect(screen.getByText(mcq.explanation)).toBeInTheDocument();
  });

  it("says correct and incorrect in words and marks them with more than colour", async () => {
    const user = userEvent.setup();
    render(<Harness item={mcq} />);
    await user.click(screen.getByRole("button", { name: "It turns into ice" }));
    expect(
      screen.getByRole("button", { name: /It turns into vapor \(correct answer\)/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /It turns into ice \(your answer\)/ }),
    ).toBeInTheDocument();
    expect(document.body.textContent).toMatch(/✓/);
    expect(document.body.textContent).toMatch(/✗/);
  });

  it("locks the options after an answer", async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<Harness item={mcq} onAnswerSpy={spy} />);
    await user.click(screen.getByRole("button", { name: mcq.answer }));
    for (const button of screen.getAllByRole("button", { name: /It turns|It falls|It sinks/ })) {
      expect(button).toBeDisabled();
    }
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("announces the result and explanation, and moves focus to Continue", async () => {
    const user = userEvent.setup();
    render(<Harness item={mcq} />);
    await user.click(screen.getByRole("button", { name: mcq.answer }));
    expect(vi.mocked(announce).mock.calls.at(-1)?.[0]).toBe(`Correct. ${mcq.explanation}`);
    await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toHaveFocus());
  });

  it("announces the correct answer when the learner is wrong", async () => {
    const user = userEvent.setup();
    render(<Harness item={mcq} />);
    await user.click(screen.getByRole("button", { name: "It turns into ice" }));
    expect(vi.mocked(announce).mock.calls.at(-1)?.[0]).toContain(`The answer is ${mcq.answer}.`);
  });

  it("calls onContinue", async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<Harness item={mcq} onContinueSpy={spy} />);
    await user.click(screen.getByRole("button", { name: mcq.answer }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("can be completed by keyboard alone", async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<Harness item={mcq} onAnswerSpy={spy} onContinueSpy={vi.fn()} />);
    await user.tab();
    expect(screen.getByRole("button", { name: mcq.options?.[0] })).toHaveFocus();
    await user.keyboard("{Tab}{Tab}"); // to the third option
    await user.keyboard("{Enter}");
    expect(spy).toHaveBeenCalledTimes(1);
    // Focus is already on Continue, so one more key finishes.
    await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toHaveFocus());
    await user.keyboard(" ");
  });

  it("gives every option a target of at least 44 pixels", () => {
    render(<Harness item={mcq} />);
    for (const option of mcq.options ?? []) {
      expect(screen.getByRole("button", { name: option }).className).toMatch(/min-h-11/);
    }
  });

  it("shows a label above the question when given one", () => {
    render(
      <QuizBlock
        item={mcq}
        phase="quiz"
        lastAnswer={null}
        onAnswer={vi.fn()}
        onContinue={vi.fn()}
        label="Question 1 of 2"
      />,
    );
    expect(screen.getByText("Question 1 of 2")).toBeInTheDocument();
  });

  it("has no axe violations before and after answering", async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness item={mcq} />);
    await expectNoAxeViolations(container);
    await user.click(screen.getByRole("button", { name: "It turns into ice" }));
    await expectNoAxeViolations(container);
  });
});

describe("QuizBlock: true or false", () => {
  it("offers True and False and grades locally", async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<Harness item={trueFalse} onAnswerSpy={spy} />);
    await user.click(screen.getByRole("button", { name: "True" }));
    expect(spy).toHaveBeenCalledWith(true, "true");
  });

  it("says the right answer in words for a wrong answer", async () => {
    const user = userEvent.setup();
    render(<Harness item={trueFalse} />);
    await user.click(screen.getByRole("button", { name: "False" }));
    expect(screen.getByText("Not quite. The answer is True.")).toBeInTheDocument();
  });

  it("has no axe violations", async () => {
    const { container } = render(<Harness item={trueFalse} />);
    await expectNoAxeViolations(container);
  });
});

describe("QuizBlock: short answer", () => {
  it("labels the field, and only enables Check once something is typed", async () => {
    const user = userEvent.setup();
    render(<Harness item={short} />);
    const check = screen.getByRole("button", { name: "Check answer" });
    expect(check).toBeDisabled();
    await user.type(screen.getByLabelText("Your answer"), "x");
    expect(check).toBeEnabled();
  });

  it("grades locally by default, accepting listed phrasings", async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<Harness item={short} onAnswerSpy={spy} />);
    await user.type(screen.getByLabelText("Your answer"), "Condensing");
    await user.click(screen.getByRole("button", { name: "Check answer" }));
    expect(spy).toHaveBeenCalledWith(true, "Condensing");
  });

  it("submits with Enter", async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<Harness item={short} onAnswerSpy={spy} />);
    await user.type(screen.getByLabelText("Your answer"), "evaporation{Enter}");
    expect(spy).toHaveBeenCalledWith(false, "evaporation");
  });

  it("uses the grader it is given and shows its feedback", async () => {
    const user = userEvent.setup();
    const grade = vi.fn(async () => ({
      correct: true,
      feedback: "Close enough: you described the idea.",
    }));
    render(<Harness item={short} gradeShortAnswer={grade} />);
    await user.type(screen.getByLabelText("Your answer"), "vapor turning to droplets");
    await user.click(screen.getByRole("button", { name: "Check answer" }));
    expect(await screen.findByText("Close enough: you described the idea.")).toBeInTheDocument();
    expect(grade).toHaveBeenCalledWith("vapor turning to droplets");
  });

  it("falls back to the strict local check when the grader fails", async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    const grade = vi.fn(async () => {
      throw new Error("grader down");
    });
    render(<Harness item={short} onAnswerSpy={spy} gradeShortAnswer={grade} />);
    await user.type(screen.getByLabelText("Your answer"), "condensation");
    await user.click(screen.getByRole("button", { name: "Check answer" }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith(true, "condensation"));
  });

  it("shows that it is checking while the grader runs, and cannot be submitted twice", async () => {
    const user = userEvent.setup();
    let release: (value: { correct: boolean }) => void = () => {};
    const grade = vi.fn(() => new Promise<{ correct: boolean }>((resolve) => (release = resolve)));
    const spy = vi.fn();
    render(<Harness item={short} onAnswerSpy={spy} gradeShortAnswer={grade} />);
    await user.type(screen.getByLabelText("Your answer"), "x{Enter}");
    expect(screen.getByRole("button", { name: "Checking…" })).toBeDisabled();
    await user.type(screen.getByLabelText("Your answer"), "{Enter}");
    expect(grade).toHaveBeenCalledTimes(1);
    release({ correct: false });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
  });

  it("does not submit a blank answer", async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<Harness item={short} onAnswerSpy={spy} />);
    await user.type(screen.getByLabelText("Your answer"), "   {Enter}");
    expect(spy).not.toHaveBeenCalled();
  });

  it("has no axe violations", async () => {
    const { container } = render(<Harness item={short} />);
    await expectNoAxeViolations(container);
  });
});

describe("ProgressBar", () => {
  it("is labelled, exposes its value and says it in words", () => {
    render(<ProgressBar value={0.4} label="Lesson progress" text="Concept 2 of 5" />);
    const bar = screen.getByRole("progressbar", { name: "Lesson progress" });
    expect(bar).toHaveAttribute("value", "40");
    expect(bar).toHaveAttribute("aria-valuetext", "Concept 2 of 5");
    expect(screen.getByText("Concept 2 of 5")).toBeInTheDocument();
  });

  it("falls back to a percentage", () => {
    render(<ProgressBar value={0.5} label="Progress" />);
    expect(screen.getByText("50 percent")).toBeInTheDocument();
  });

  it.each([
    [-1, "0"],
    [2, "100"],
    [NaN, "0"],
    [0.126, "13"],
  ])("clamps %s to %s percent", (value, percent) => {
    render(<ProgressBar value={value} label="Progress" />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("value", percent);
  });

  it("has no axe violations", async () => {
    const { container } = render(
      <ProgressBar value={0.3} label="Lesson progress" text="3 of 10" />,
    );
    await expectNoAxeViolations(container);
  });
});

describe("ProfileSwitcher", () => {
  it("offers every preset as a toggle button named for an experience", () => {
    render(<ProfileSwitcher profile={presetProfile("standard")} onSelect={vi.fn()} />);
    for (const name of [
      "Standard",
      "Talk it through",
      "One idea at a time",
      "Easy reading",
      "Pictures and signs",
    ]) {
      expect(screen.getByRole("button", { name: new RegExp(name) })).toBeInTheDocument();
    }
    expect(document.body.textContent).not.toMatch(/adhd|dyslex|autis|blind|deaf|disab/i);
  });

  it("marks only the current preset as pressed", () => {
    render(<ProfileSwitcher profile={presetProfile("hyper_focus")} onSelect={vi.fn()} />);
    const pressed = screen
      .getAllByRole("button")
      .filter((b) => b.getAttribute("aria-pressed") === "true");
    expect(pressed).toHaveLength(1);
    expect(pressed[0]).toHaveTextContent("One idea at a time");
  });

  it("says custom settings are in use and presses nothing for a custom profile", () => {
    render(<ProfileSwitcher profile={presetProfile("custom")} onSelect={vi.fn()} />);
    expect(screen.getByText("Your own settings are in use.")).toBeInTheDocument();
    expect(
      screen.getAllByRole("button").some((b) => b.getAttribute("aria-pressed") === "true"),
    ).toBe(false);
  });

  it("selects a preset only when pressed, by mouse or keyboard", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<ProfileSwitcher profile={presetProfile("standard")} onSelect={onSelect} />);
    await user.tab();
    await user.tab(); // moving focus does not select
    expect(onSelect).not.toHaveBeenCalled();
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith("voice_native");
    await user.click(screen.getByRole("button", { name: /Easy reading/ }));
    expect(onSelect).toHaveBeenLastCalledWith("cognitive_ease");
  });

  it("has no axe violations", async () => {
    const { container } = render(
      <ProfileSwitcher profile={presetProfile("visual_sign")} onSelect={vi.fn()} />,
    );
    await expectNoAxeViolations(container);
  });
});
