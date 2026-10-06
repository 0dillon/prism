// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ReviewEditor,
  SaveError,
  type PublishFn,
  type SaveFn,
} from "@/app/teach/lessons/[id]/review/ReviewEditor";
import { announce, LiveRegions } from "@/lib/a11y/live-region";
import type { KnowledgeGraph } from "@/lib/schemas/knowledge-graph";
import { expectNoAxeViolations } from "../a11y";
import { makeGraph } from "../fixtures/graph";

vi.mock("@/lib/a11y/live-region", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/a11y/live-region")>();
  return { ...original, announce: vi.fn(original.announce) };
});

/** A fixture with two sections and one flagged concept, like a real extraction. */
function reviewGraph(): KnowledgeGraph {
  const graph = makeGraph();
  graph.sections.push({ id: "s_2", title: "Falling water", order: 1 });
  graph.concepts[2].sectionId = "s_2";
  graph.concepts[1].flags = ["low_confidence"];
  return graph;
}

const okSave = (): SaveFn =>
  vi.fn(async (_id, body) => ({
    graph: body.graph,
    warnings: [],
    updatedAt: "2026-10-06T11:00:00.000Z",
  }));

const okPublish = (): PublishFn => vi.fn(async () => ({ version: 1, warnings: [] }));

function setup(graph = reviewGraph(), save: SaveFn = okSave(), publish: PublishFn = okPublish()) {
  const user = userEvent.setup();
  const view = render(
    <>
      <ReviewEditor
        lessonId="lesson-1"
        initialGraph={graph}
        initialUpdatedAt="2026-10-06T10:00:00.000Z"
        save={save}
        publish={publish}
      />
      <LiveRegions />
    </>,
  );
  return { user, save, publish, ...view };
}

const conceptTitles = () =>
  screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent?.replace(/^\d+\.\s*/, ""));

/** The editor's own alert. The live region also has role="alert" and repeats the message. */
const editorAlert = () => document.querySelector('[role="alert"][tabindex="-1"]');

const lastAnnouncement = () => {
  const calls = vi.mocked(announce).mock.calls;
  return calls[calls.length - 1]?.[0];
};

beforeEach(() => {
  vi.mocked(announce).mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("ReviewEditor: layout", () => {
  it("lists concepts by section with sequential headings", () => {
    setup();
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
      "Needs your attention",
      "How water moves",
      "Falling water",
    ]);
    expect(conceptTitles()).toEqual(["Condensation", "Evaporation", "Precipitation"]);
  });

  it("puts flagged concepts first, in their own group, and explains why", () => {
    setup();
    const group = screen.getByRole("region", { name: "Needs your attention" });
    expect(within(group).getByRole("heading", { level: 3 })).toHaveTextContent("Condensation");
    expect(within(group).getByText(/Prism was not sure about this one/)).toBeInTheDocument();
  });

  it("shows the source excerpt beside each concept with where it came from", () => {
    setup();
    const source = screen.getByRole("complementary", { name: "Source for concept 2" });
    expect(within(source).getByText(/As vapor rises it cools and condenses/)).toBeInTheDocument();
    expect(within(source).getByText("Page 1")).toBeInTheDocument();
  });

  it("summarizes the counts", () => {
    setup();
    expect(
      screen.getByText(/3 concepts, 6 quiz questions, 1 needs your attention\./),
    ).toBeInTheDocument();
  });

  it("has no axe violations", async () => {
    const { container } = setup();
    await expectNoAxeViolations(container, { rules: ["landmark-unique"] });
  });
});

describe("ReviewEditor: editing and saving", () => {
  it("starts clean and enables saving once something changes", async () => {
    const { user } = setup();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    expect(screen.getByText("All changes saved.")).toBeInTheDocument();

    const title = screen.getAllByLabelText("Title")[0];
    await user.clear(title);
    await user.type(title, "Cloud formation");

    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
    expect(screen.getByText("You have unsaved changes.")).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 3 })[0]).toHaveTextContent("Cloud formation");
  });

  it("saves the whole graph with the version it loaded and then reports it saved", async () => {
    const { user, save } = setup();
    const summary = screen.getAllByLabelText("Summary")[1];
    await user.clear(summary);
    await user.type(summary, "A clearer summary.");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const [lessonId, body] = vi.mocked(save).mock.calls[0];
    expect(lessonId).toBe("lesson-1");
    expect(body.expectedUpdatedAt).toBe("2026-10-06T10:00:00.000Z");
    expect(body.graph.concepts.find((c) => c.id === "c_evaporation")?.summary).toBe(
      "A clearer summary.",
    );

    await screen.findByText("All changes saved.");
    expect(lastAnnouncement()).toBe("Changes saved.");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("sends the new version on the next save", async () => {
    const { user, save } = setup();
    const title = screen.getAllByLabelText("Title")[0];
    await user.type(title, "!");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("All changes saved.");
    await user.type(screen.getAllByLabelText("Title")[0], "?");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(vi.mocked(save).mock.calls[1][1].expectedUpdatedAt).toBe("2026-10-06T11:00:00.000Z");
  });

  it("shows warnings the server returns", async () => {
    const save: SaveFn = vi.fn(async (_id, body) => ({
      graph: body.graph,
      warnings: [{ path: "concepts[0]", message: 'concept "Evaporation" has 1 quiz item(s)' }],
      updatedAt: "2026-10-06T11:00:00.000Z",
    }));
    const { user } = setup(reviewGraph(), save);
    await user.type(screen.getAllByLabelText("Title")[0], "!");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("heading", { name: "Worth a look" })).toBeInTheDocument();
    expect(screen.getByText(/has 1 quiz item/)).toBeInTheDocument();
  });

  it("reports a failed save as an alert, keeps the edits and stays unsaved", async () => {
    const save: SaveFn = vi.fn(async () => {
      throw new SaveError("We could not save your changes. Please try again.", "save_failed");
    });
    const { user } = setup(reviewGraph(), save);
    await user.type(screen.getAllByLabelText("Title")[0], "!");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(editorAlert()).not.toBeNull());
    expect(editorAlert()).toHaveTextContent(/could not save your changes/);
    expect(screen.getByText("You have unsaved changes.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
    expect(lastAnnouncement()).toMatch(/^Not saved\./);
  });

  it("offers a reload when the lesson was changed elsewhere", async () => {
    const save: SaveFn = vi.fn(async () => {
      throw new SaveError("This lesson was changed somewhere else.", "conflict");
    });
    const { user } = setup(reviewGraph(), save);
    await user.type(screen.getAllByLabelText("Title")[0], "!");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(
      await screen.findByRole("button", { name: "Reload the latest version" }),
    ).toBeInTheDocument();
  });

  it("blocks saving a concept with no title and lists the problem, moving focus to it", async () => {
    const { user, save } = setup();
    await user.clear(screen.getAllByLabelText("Title")[1]);
    expect(screen.getByText("Give this concept a title.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(save).not.toHaveBeenCalled();
    expect(await screen.findByText(/A concept has no title\./)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText("Fix these before saving:").closest("[role=alert]")).toHaveFocus(),
    );
  });
});

describe("ReviewEditor: reordering", () => {
  it("moves a concept down and announces its new position", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: /Move down: concept 1, Evaporation/ }));
    expect(lastAnnouncement()).toMatch(/Moved Evaporation down\. It is now concept 2 of 3\./);
  });

  it("keeps focus on the move button after moving, so it can be pressed again", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: /Move down: concept 1, Evaporation/ }));
    await waitFor(() => expect(document.activeElement?.id).toBe("move-down-c_evaporation"));
  });

  it("moves focus to the other button when a move reaches the end", async () => {
    const { user } = setup();
    // Evaporation is concept 1 of 3. Down twice puts it last, where Move down is disabled.
    await user.click(screen.getByRole("button", { name: /Move down: concept 1, Evaporation/ }));
    await waitFor(() => expect(document.activeElement?.id).toBe("move-down-c_evaporation"));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(document.activeElement?.id).toBe("move-up-c_evaporation"));
  });

  it("disables moving up for the first concept and down for the last", () => {
    setup();
    expect(screen.getByRole("button", { name: /Move up: concept 1/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Move down: concept 3/ })).toBeDisabled();
  });

  it("makes the moved order savable", async () => {
    const { user, save } = setup();
    await user.click(screen.getByRole("button", { name: /Move down: concept 1, Evaporation/ }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    const saved = vi.mocked(save).mock.calls[0][1].graph;
    expect(saved.concepts.map((c) => c.order)).toEqual([0, 1, 2]);
    expect(saved.concepts.map((c) => c.id)).toEqual([
      "c_condensation",
      "c_evaporation",
      "c_precipitation",
    ]);
  });
});

describe("ReviewEditor: deleting and merging", () => {
  it("asks for confirmation, and cancelling changes nothing", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: /Delete concept 1: Evaporation/ }));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete this concept?" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(conceptTitles()).toContain("Evaporation");
    expect(screen.getByText("All changes saved.")).toBeInTheDocument();
  });

  it("puts initial focus on Cancel so Enter is safe", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: /Delete concept 1: Evaporation/ }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("closes the dialog with Escape and returns focus to the button that opened it", async () => {
    const { user } = setup();
    const trigger = screen.getByRole("button", { name: /Delete concept 1: Evaporation/ });
    await user.click(trigger);
    await screen.findByRole("alertdialog");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("deletes a concept and its questions once confirmed, announces it and focuses a neighbor", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: /Delete concept 1: Evaporation/ }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Delete concept" }));

    await waitFor(() => expect(conceptTitles()).not.toContain("Evaporation"));
    expect(screen.getByText(/2 concepts, 4 quiz questions/)).toBeInTheDocument();
    expect(lastAnnouncement()).toBe("Deleted Evaporation.");
    await waitFor(() => expect(document.activeElement?.tagName).toBe("H3"));
    expect(screen.getByText("You have unsaved changes.")).toBeInTheDocument();
  });

  it("merges a concept into the previous one after confirmation", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: /Merge into previous: concept 3/ }));
    const dialog = await screen.findByRole("alertdialog", {
      name: "Merge into the previous concept?",
    });
    await user.click(within(dialog).getByRole("button", { name: "Merge" }));
    await waitFor(() => expect(conceptTitles()).not.toContain("Precipitation"));
    expect(screen.getByText(/2 concepts, 6 quiz questions/)).toBeInTheDocument();
  });

  it("does not offer to merge the first concept", () => {
    setup();
    expect(
      screen.queryByRole("button", { name: /Merge into previous: concept 1/ }),
    ).not.toBeInTheDocument();
  });

  it("has no axe violations with a dialog open", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: /Delete concept 1: Evaporation/ }));
    await screen.findByRole("alertdialog");
    await expectNoAxeViolations(document.body, { rules: ["landmark-unique"] });
  });
});

describe("ReviewEditor: flagged concepts", () => {
  it("moves a concept out of the attention group once marked as checked", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Mark as checked" }));
    expect(screen.queryByRole("heading", { name: "Needs your attention" })).not.toBeInTheDocument();
    expect(conceptTitles()).toEqual(["Evaporation", "Condensation", "Precipitation"]);
    expect(lastAnnouncement()).toBe("Marked Condensation as checked.");
  });
});

describe("ReviewEditor: adding", () => {
  it("adds a concept to a section and moves focus to it", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Add a concept to Falling water" }));
    await waitFor(() => expect(conceptTitles()).toContain("New concept"));
    expect(screen.getByText(/4 concepts/)).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toHaveTextContent(/New concept/));
  });

  it("shows that a new concept has no source and no questions yet", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Add a concept to Falling water" }));
    expect(
      await screen.findByText(/no source passage because you added it yourself/),
    ).toBeInTheDocument();
    expect(screen.getByText(/There are no questions for this concept yet/)).toBeInTheDocument();
  });
});

describe("ReviewEditor: quiz editing", () => {
  const firstQuiz = () =>
    screen.getAllByRole("heading", { level: 4, name: /Question 1 of/ })[0].closest("section")!;

  it("renders each question with labelled fields", () => {
    setup();
    const quiz = within(firstQuiz());
    expect(quiz.getByLabelText("Question type")).toHaveValue("mcq");
    expect(quiz.getByLabelText("Question")).toBeInTheDocument();
    expect(quiz.getByRole("group", { name: "Answer options" })).toBeInTheDocument();
    expect(quiz.getByLabelText("Option 1")).toBeInTheDocument();
    expect(quiz.getByLabelText("Explanation shown after answering")).toBeInTheDocument();
  });

  it("saves an edited multiple choice question and keeps it valid", async () => {
    const { user, save } = setup();
    const quiz = within(firstQuiz());
    const prompt = quiz.getByLabelText("Question");
    await user.clear(prompt);
    await user.type(prompt, "What does the sun do to ocean water?");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    const saved = vi.mocked(save).mock.calls[0][1].graph;
    expect(
      saved.quizItems.find((q) => q.prompt === "What does the sun do to ocean water?"),
    ).toBeDefined();
  });

  it("changes the correct answer with the radio group", async () => {
    const { user, save } = setup();
    const quiz = within(firstQuiz());
    await user.click(quiz.getByRole("radio", { name: "Option 2 is the correct answer" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    const item = vi
      .mocked(save)
      .mock.calls[0][1].graph.quizItems.find((q) => q.id === "q_condensation_1");
    expect(item?.answer).toBe(item?.options?.[1]);
  });

  it("keeps the answer in step when the correct option is renamed", async () => {
    const { user, save } = setup();
    const quiz = within(firstQuiz());
    const correct = quiz.getAllByRole("radio").findIndex((r) => (r as HTMLInputElement).checked);
    const option = quiz.getByLabelText(`Option ${correct + 1}`);
    await user.clear(option);
    await user.type(option, "Rewritten answer");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    const item = vi
      .mocked(save)
      .mock.calls[0][1].graph.quizItems.find((q) => q.id === "q_condensation_1")!;
    expect(item.answer).toBe("Rewritten answer");
    expect(item.options).toContain("Rewritten answer");
  });

  it("shows a problem for a blank option and blocks saving until it is fixed", async () => {
    const { user, save } = setup();
    const quiz = within(firstQuiz());
    const wrong = quiz.getAllByRole("radio").findIndex((r) => !(r as HTMLInputElement).checked);
    await user.clear(quiz.getByLabelText(`Option ${wrong + 1}`));
    expect(quiz.getByText("Write this option or remove it.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(save).not.toHaveBeenCalled();
    expect(await screen.findByText(/needs fixing/)).toBeInTheDocument();
  });

  it("switches a question to true or false and shows the right controls", async () => {
    const { user } = setup();
    const quiz = within(firstQuiz());
    await user.selectOptions(quiz.getByLabelText("Question type"), "true_false");
    expect(quiz.queryByRole("group", { name: "Answer options" })).not.toBeInTheDocument();
    expect(quiz.getByRole("group", { name: "Correct answer" })).toBeInTheDocument();
    expect(quiz.getByRole("radio", { name: "True" })).toBeChecked();
  });

  it("switches a question to short answer and accepts several phrasings", async () => {
    const { user, save } = setup();
    const quiz = within(firstQuiz());
    await user.selectOptions(quiz.getByLabelText("Question type"), "short_answer");
    await user.type(quiz.getByLabelText("Other answers to accept"), "clouds{Enter}cloud");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    const item = vi
      .mocked(save)
      .mock.calls[0][1].graph.quizItems.find((q) => q.id === "q_condensation_1")!;
    expect(item.type).toBe("short_answer");
    expect(item.acceptable).toEqual(["clouds", "cloud"]);
    expect(item.options).toBeUndefined();
  });

  it("adds and removes options within the 3 to 4 limit", async () => {
    const { user } = setup();
    const quiz = within(firstQuiz());
    expect(quiz.queryByRole("button", { name: /Remove option/ })).not.toBeInTheDocument(); // already at 3
    await user.click(quiz.getByRole("button", { name: "Add option" }));
    expect(quiz.getAllByRole("radio")).toHaveLength(4);
    expect(quiz.queryByRole("button", { name: "Add option" })).not.toBeInTheDocument(); // at the max
    await user.click(quiz.getByRole("button", { name: "Remove option 4" }));
    expect(quiz.getAllByRole("radio")).toHaveLength(3);
  });

  it("adds a question to a concept", async () => {
    const { user } = setup();
    expect(screen.getByText(/3 concepts, 6 quiz questions/)).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "Add a question" })[0]);
    expect(screen.getByText(/3 concepts, 7 quiz questions/)).toBeInTheDocument();
    expect(lastAnnouncement()).toBe("Question added.");
  });

  it("deletes a question after confirmation", async () => {
    const { user } = setup();
    await user.click(within(firstQuiz()).getByRole("button", { name: "Delete question 1" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete this question?" });
    await user.click(within(dialog).getByRole("button", { name: "Delete question" }));
    await waitFor(() =>
      expect(screen.getByText(/3 concepts, 5 quiz questions/)).toBeInTheDocument(),
    );
  });

  it("has no axe violations for each question type", async () => {
    const { user, container } = setup();
    const quiz = within(firstQuiz());
    await expectNoAxeViolations(container, { rules: ["landmark-unique"] });
    await user.selectOptions(quiz.getByLabelText("Question type"), "true_false");
    await expectNoAxeViolations(container, { rules: ["landmark-unique"] });
    await user.selectOptions(quiz.getByLabelText("Question type"), "short_answer");
    await expectNoAxeViolations(container, { rules: ["landmark-unique"] });
  });
});

describe("ReviewEditor: keyboard", () => {
  it("can be used with the keyboard alone: edit a field, then save with Enter", async () => {
    const { user, save } = setup();
    screen.getAllByLabelText("Title")[0].focus();
    await user.keyboard(" extra");
    const saveButton = screen.getByRole("button", { name: "Save changes" });
    saveButton.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  });
});

describe("ReviewEditor: publishing", () => {
  it("cannot publish while there are unsaved changes, and says why", async () => {
    const { user } = setup();
    expect(screen.getByRole("button", { name: "Publish lesson" })).toBeEnabled();
    await user.type(screen.getAllByLabelText("Title")[0], "!");
    expect(screen.getByRole("button", { name: "Publish lesson" })).toBeDisabled();
    expect(screen.getByText("Save your changes before publishing.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("All changes saved.");
    expect(screen.getByRole("button", { name: "Publish lesson" })).toBeEnabled();
  });

  it("asks for confirmation, and cancelling does not publish", async () => {
    const { user, publish } = setup();
    await user.click(screen.getByRole("button", { name: "Publish lesson" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Publish this lesson?" });
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(publish).not.toHaveBeenCalled();
  });

  it("publishes once confirmed, announces it and moves focus to the result", async () => {
    const { user, publish } = setup();
    await user.click(screen.getByRole("button", { name: "Publish lesson" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Publish" }));

    await screen.findByRole("heading", { name: "Your lesson is published" });
    expect(publish).toHaveBeenCalledWith("lesson-1");
    expect(lastAnnouncement()).toBe("Your lesson is published.");
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Your lesson is published" }).parentElement,
      ).toHaveFocus(),
    );
    // The editor is gone, so it cannot be edited into a different state than what was published.
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
  });

  it("reports a failed publish as an alert and keeps the editor", async () => {
    const publish: PublishFn = vi.fn(async () => {
      throw new SaveError("This lesson has a problem that must be fixed first.", "invalid_graph");
    });
    const { user } = setup(reviewGraph(), okSave(), publish);
    await user.click(screen.getByRole("button", { name: "Publish lesson" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Publish" }),
    );
    await waitFor(() => expect(editorAlert()).not.toBeNull());
    expect(editorAlert()).toHaveTextContent(/must be fixed first/);
    expect(screen.getByRole("button", { name: "Save changes" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Publish lesson" })).toBeEnabled();
    expect(lastAnnouncement()).toMatch(/^Not published\./);
  });

  it("shows what is worth a look before publishing a thin lesson", () => {
    const thin = reviewGraph();
    thin.quizItems = thin.quizItems.filter((q) => q.conceptId !== "c_condensation");
    setup(thin);
    expect(screen.getByRole("heading", { name: "Worth a look" })).toBeInTheDocument();
    expect(screen.getByText(/"Condensation" has 0 quiz item/)).toBeInTheDocument();
  });

  it("has no axe violations with the publish dialog open", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Publish lesson" }));
    await screen.findByRole("alertdialog");
    await expectNoAxeViolations(document.body, { rules: ["landmark-unique"] });
  });
});
