// @vitest-environment jsdom
import { act, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { announce, LiveRegions } from "@/lib/a11y/live-region";
import { UploadForm } from "@/app/teach/upload/UploadForm";
import {
  checkFile,
  describeState,
  formatSize,
  INITIAL_STATE,
  useUploadFlow,
  type StatusResponse,
  type UploadDeps,
} from "@/app/teach/upload/flow";
import { MAX_UPLOAD_BYTES } from "@/lib/supabase/storage";
import { expectNoAxeViolations } from "../a11y";

const file = (name = "notes.pdf", size = 2048) => {
  const f = new File(["x"], name, { type: "application/octet-stream" });
  Object.defineProperty(f, "size", { value: size });
  return f;
};

/** Fake dependencies where status answers come from a script. */
function makeDeps(
  statuses: Array<StatusResponse | Error> = [],
  overrides: Partial<UploadDeps> = {},
) {
  const announced: Array<[string, string | undefined]> = [];
  const queue = [...statuses];
  const deps: UploadDeps = {
    createLesson: vi.fn(async () => ({
      lessonId: "lesson-1",
      jobId: "job-1",
      upload: { path: "u/lesson-1/source.pdf", token: "tok" },
    })),
    uploadFile: vi.fn(async () => {}),
    startIngest: vi.fn(async () => {}),
    getStatus: vi.fn(async () => {
      const next = queue.shift();
      if (!next) throw new Error("no more scripted statuses");
      if (next instanceof Error) throw next;
      return next;
    }),
    announce: (message, priority) => announced.push([message, priority]),
    sleep: async () => {},
    pollIntervalMs: 0,
    maxWaitMs: 60_000,
    ...overrides,
  };
  return { deps, announced };
}

const processing = (stageLabel: string, progress: number): StatusResponse => ({
  stageLabel,
  progress,
  error: null,
  ready: false,
});
const ready: StatusResponse = {
  stageLabel: "Ready for review",
  progress: 100,
  error: null,
  ready: true,
};

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("checkFile", () => {
  it.each(["a.pdf", "a.PDF", "a.txt", "a.md"])("accepts %s", (name) => {
    expect(checkFile({ name, size: 100 })).toBeNull();
  });

  it("rejects unknown, audio and Word files with plain messages", () => {
    expect(checkFile({ name: "a.exe", size: 1 })).toMatch(/not accepted/);
    expect(checkFile({ name: "a.mp3", size: 1 })).toMatch(/Audio files are not supported yet/);
    expect(checkFile({ name: "a.docx", size: 1 })).toMatch(/Word documents are not supported yet/);
  });

  it("rejects empty and oversized files, and accepts exactly 50 MB", () => {
    expect(checkFile({ name: "a.pdf", size: 0 })).toMatch(/empty/);
    expect(checkFile({ name: "a.pdf", size: MAX_UPLOAD_BYTES + 1 })).toMatch(/50 MB/);
    expect(checkFile({ name: "a.pdf", size: MAX_UPLOAD_BYTES })).toBeNull();
  });
});

describe("formatSize and describeState", () => {
  it("formats sizes", () => {
    expect(formatSize(500)).toBe("500 bytes");
    expect(formatSize(2048)).toBe("2.0 KB");
    expect(formatSize(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("describes each phase in words", () => {
    expect(describeState(INITIAL_STATE)).toBe("");
    expect(describeState({ ...INITIAL_STATE, phase: "uploading" })).toBe("Uploading your file");
    expect(
      describeState({
        ...INITIAL_STATE,
        phase: "processing",
        stageLabel: "Organizing the lesson",
        progress: 52,
      }),
    ).toBe("Organizing the lesson, 52 percent");
    expect(describeState({ ...INITIAL_STATE, phase: "ready" })).toBe("Ready for review");
  });
});

describe("useUploadFlow", () => {
  it("runs create, upload, ingest and polling to ready, in order", async () => {
    const { deps } = makeDeps([
      processing("Reading the file", 5),
      processing("Finding the key ideas", 30),
      ready,
    ]);
    const { result } = renderHook(() => useUploadFlow(deps));
    await act(async () => {
      await result.current.start(file(), "My lesson");
    });

    expect(deps.createLesson).toHaveBeenCalledWith({
      fileName: "notes.pdf",
      fileSize: 2048,
      title: "My lesson",
    });
    expect(deps.uploadFile).toHaveBeenCalledWith(
      { path: "u/lesson-1/source.pdf", token: "tok" },
      expect.any(File),
    );
    expect(deps.startIngest).toHaveBeenCalledWith("lesson-1");
    expect(result.current.state).toMatchObject({
      phase: "ready",
      lessonId: "lesson-1",
      progress: 100,
    });

    const order = [
      vi.mocked(deps.createLesson).mock.invocationCallOrder[0],
      vi.mocked(deps.uploadFile).mock.invocationCallOrder[0],
      vi.mocked(deps.startIngest).mock.invocationCallOrder[0],
      vi.mocked(deps.getStatus).mock.invocationCallOrder[0],
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("announces each stage once, plus completion", async () => {
    const { deps, announced } = makeDeps([
      processing("Reading the file", 5),
      processing("Reading the file", 8),
      processing("Finding the key ideas", 30),
      ready,
    ]);
    const { result } = renderHook(() => useUploadFlow(deps));
    await act(async () => {
      await result.current.start(file());
    });
    const messages = announced.map(([m]) => m);
    expect(messages.filter((m) => m === "Reading the file")).toHaveLength(1);
    expect(messages).toContain("Finding the key ideas");
    expect(messages.at(-1)).toBe("Your lesson is ready for review.");
    expect(messages).toContain("Uploading your file.");
  });

  it("does not send a blank title", async () => {
    const { deps } = makeDeps([ready]);
    const { result } = renderHook(() => useUploadFlow(deps));
    await act(async () => {
      await result.current.start(file(), "   ");
    });
    expect(vi.mocked(deps.createLesson).mock.calls[0][0].title).toBeUndefined();
  });

  it("rejects an unusable file without calling the network, and announces it assertively", async () => {
    const { deps, announced } = makeDeps();
    const { result } = renderHook(() => useUploadFlow(deps));
    await act(async () => {
      await result.current.start(file("virus.exe"));
    });
    expect(deps.createLesson).not.toHaveBeenCalled();
    expect(result.current.state).toMatchObject({ phase: "failed" });
    expect(announced.at(-1)?.[1]).toBe("assertive");
  });

  it("fails with the server's message when processing fails", async () => {
    const { deps, announced } = makeDeps([
      processing("Reading the file", 5),
      {
        stageLabel: "Reading the file",
        progress: 5,
        error: "The PDF has no text layer.",
        ready: false,
      },
    ]);
    const { result } = renderHook(() => useUploadFlow(deps));
    await act(async () => {
      await result.current.start(file());
    });
    expect(result.current.state).toMatchObject({
      phase: "failed",
      error: "The PDF has no text layer.",
    });
    expect(announced.at(-1)).toEqual([
      "Processing failed. The PDF has no text layer.",
      "assertive",
    ]);
  });

  it("fails clearly when the lesson cannot be created", async () => {
    const { deps } = makeDeps([], {
      createLesson: vi.fn(async () => {
        throw new Error("Files can be up to 50 MB.");
      }),
    });
    const { result } = renderHook(() => useUploadFlow(deps));
    await act(async () => {
      await result.current.start(file());
    });
    expect(result.current.state).toMatchObject({
      phase: "failed",
      error: "Files can be up to 50 MB.",
    });
    expect(deps.uploadFile).not.toHaveBeenCalled();
  });

  it("does not start processing if the upload fails", async () => {
    const { deps } = makeDeps([], {
      uploadFile: vi.fn(async () => {
        throw new Error("upload broke");
      }),
    });
    const { result } = renderHook(() => useUploadFlow(deps));
    await act(async () => {
      await result.current.start(file());
    });
    expect(deps.startIngest).not.toHaveBeenCalled();
    expect(result.current.state.phase).toBe("failed");
    expect(result.current.state.lessonId).toBe("lesson-1");
  });

  it("keeps polling through a couple of failed requests", async () => {
    const { deps } = makeDeps([
      new Error("blip"),
      new Error("blip"),
      processing("Reading the file", 5),
      ready,
    ]);
    const { result } = renderHook(() => useUploadFlow(deps));
    await act(async () => {
      await result.current.start(file());
    });
    expect(result.current.state.phase).toBe("ready");
  });

  it("gives up after repeated failed polls", async () => {
    const { deps } = makeDeps(Array.from({ length: 6 }, () => new Error("offline")));
    const { result } = renderHook(() => useUploadFlow(deps));
    await act(async () => {
      await result.current.start(file());
    });
    expect(result.current.state).toMatchObject({ phase: "failed" });
    expect(result.current.state.error).toMatch(/lost contact/);
  });

  it("stops waiting after the maximum time", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { deps } = makeDeps(
      Array.from({ length: 50 }, () => processing("Reading the file", 5)),
      {
        sleep: async () => {
          now += 20_000;
        },
        maxWaitMs: 60_000,
      },
    );
    const { result } = renderHook(() => useUploadFlow(deps));
    await act(async () => {
      await result.current.start(file());
    });
    expect(result.current.state.error).toMatch(/taking longer than expected/);
  });

  it("retries a failed lesson without uploading again", async () => {
    const { deps } = makeDeps([
      {
        stageLabel: "x",
        progress: 5,
        error: "Something went wrong while processing the file.",
        ready: false,
      },
      ready,
    ]);
    const { result } = renderHook(() => useUploadFlow(deps));
    await act(async () => {
      await result.current.start(file());
    });
    expect(result.current.state.phase).toBe("failed");
    await act(async () => {
      await result.current.retry();
    });
    expect(result.current.state.phase).toBe("ready");
    expect(deps.createLesson).toHaveBeenCalledTimes(1);
    expect(deps.uploadFile).toHaveBeenCalledTimes(1);
    expect(deps.startIngest).toHaveBeenCalledTimes(2);
  });

  it("stops polling when the component unmounts", async () => {
    let release: () => void = () => {};
    const { deps } = makeDeps(
      Array.from({ length: 20 }, () => processing("Reading the file", 5)),
      {
        sleep: () => new Promise<void>((resolve) => (release = resolve)),
      },
    );
    const { result, unmount } = renderHook(() => useUploadFlow(deps));
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.start(file());
    });
    await waitFor(() => expect(deps.getStatus).toHaveBeenCalledTimes(1));
    unmount();
    release();
    await pending;
    expect(deps.getStatus).toHaveBeenCalledTimes(1);
  });
});

describe("UploadForm", () => {
  const renderForm = (
    statuses: Array<StatusResponse | Error> = [ready],
    overrides: Partial<UploadDeps> = {},
    options: { realAnnounce?: boolean } = {},
  ) => {
    const { deps, announced } = makeDeps(statuses, overrides);
    if (options.realAnnounce) deps.announce = announce;
    const view = render(
      <>
        <UploadForm deps={deps} />
        <LiveRegions />
      </>,
    );
    return { deps, announced, ...view };
  };

  const chooseFile = async (user: ReturnType<typeof userEvent.setup>, f: File) => {
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, f);
  };

  it("has no axe violations before and after choosing a file", async () => {
    const user = userEvent.setup();
    const { container } = renderForm();
    await expectNoAxeViolations(container);
    await chooseFile(user, file());
    await expectNoAxeViolations(container);
  });

  it("labels the controls and describes the accepted files", () => {
    renderForm();
    expect(screen.getByLabelText(/Lesson title/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose a file" })).toBeInTheDocument();
    expect(screen.getByText(/PDF, TXT, or Markdown, up to 50 MB/)).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /Drag a file here/ })).toBeInTheDocument();
  });

  it("can be completed by keyboard alone", async () => {
    const user = userEvent.setup();
    const { deps } = renderForm([processing("Reading the file", 10), ready]);

    await user.tab(); // title
    expect(screen.getByLabelText(/Lesson title/i)).toHaveFocus();
    await user.tab(); // Choose a file
    expect(screen.getByRole("button", { name: "Choose a file" })).toHaveFocus();
    await chooseFile(user, file("lesson.md", 500));
    await user.tab(); // submit
    const submit = screen.getByRole("button", { name: "Upload and process" });
    expect(submit).toHaveFocus();
    await user.keyboard("{Enter}");

    await screen.findByRole("heading", { name: /ready for review/i });
    expect(deps.createLesson).toHaveBeenCalledTimes(1);
  });

  it("shows and announces the selected file", async () => {
    const user = userEvent.setup();
    const { announced } = renderForm();
    await chooseFile(user, file("water.pdf", 3072));
    expect(screen.getByText("water.pdf")).toBeInTheDocument();
    expect(announced.map(([m]) => m)).toContain("Selected water.pdf, 3.0 KB.");
  });

  it("rejects a bad file with an alert and does not select it", async () => {
    // A real file picker filters by `accept`, but drag and drop does not, so test past it.
    const user = userEvent.setup({ applyAccept: false });
    renderForm();
    await chooseFile(user, file("tool.exe"));
    expect(screen.getByText(/not accepted/).closest("[role=alert]")).not.toBeNull();
    expect(screen.queryByText(/Selected:/)).not.toBeInTheDocument();
  });

  it("tells the user to choose a file when they submit with none, and focuses the button", async () => {
    const user = userEvent.setup();
    const { deps } = renderForm();
    await user.click(screen.getByRole("button", { name: "Upload and process" }));
    expect(screen.getByText("Choose a file first.").closest("[role=alert]")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Choose a file" })).toHaveFocus();
    expect(deps.createLesson).not.toHaveBeenCalled();
  });

  it("shows progress with a labelled progress bar while processing", async () => {
    const user = userEvent.setup();
    let release: () => void = () => {};
    renderForm([processing("Finding the key ideas", 30), ready], {
      sleep: () => new Promise<void>((resolve) => (release = resolve)),
    });
    await chooseFile(user, file());
    await user.click(screen.getByRole("button", { name: "Upload and process" }));

    const bar = await screen.findByRole("progressbar", { name: "Processing progress" });
    expect(bar).toHaveAttribute("value", "30");
    expect(screen.getByText("Finding the key ideas, 30 percent")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Working…" })).toBeDisabled();
    release();
    await screen.findByRole("heading", { name: /ready for review/i });
  });

  it("announces stage changes through the live region", async () => {
    const user = userEvent.setup();
    renderForm([processing("Organizing the lesson", 52), ready], {}, { realAnnounce: true });
    await chooseFile(user, file());
    await user.click(screen.getByRole("button", { name: "Upload and process" }));
    await screen.findByRole("heading", { name: /ready for review/i });
    expect(screen.getByRole("status")).toHaveTextContent("Your lesson is ready for review.");
  });

  it("links to the review page and moves focus to the result when ready", async () => {
    const user = userEvent.setup();
    renderForm();
    await chooseFile(user, file());
    await user.click(screen.getByRole("button", { name: "Upload and process" }));
    const link = await screen.findByRole("link", { name: "Review lesson" });
    expect(link).toHaveAttribute("href", "/teach/lessons/lesson-1/review");
    await waitFor(() => {
      const result = link.closest("div[tabindex]") as HTMLElement;
      expect(result).toHaveFocus();
    });
  });

  it("shows a failure as an alert with a way to try again", async () => {
    const user = userEvent.setup();
    const { deps } = renderForm([
      { stageLabel: "x", progress: 5, error: "The PDF has no text layer.", ready: false },
      ready,
    ]);
    await chooseFile(user, file());
    await user.click(screen.getByRole("button", { name: "Upload and process" }));
    const failure = await screen.findByRole("heading", { name: /could not finish/i });
    expect(within(failure.parentElement as HTMLElement).getByRole("alert")).toHaveTextContent(
      "The PDF has no text layer.",
    );
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("heading", { name: /ready for review/i });
    expect(deps.startIngest).toHaveBeenCalledTimes(2);
    expect(deps.uploadFile).toHaveBeenCalledTimes(1);
  });

  it("lets the user start over after finishing", async () => {
    const user = userEvent.setup();
    renderForm();
    await chooseFile(user, file());
    await user.click(screen.getByRole("button", { name: "Upload and process" }));
    await user.click(await screen.findByRole("button", { name: "Upload another file" }));
    expect(screen.getByRole("button", { name: "Choose a file" })).toBeVisible();
    expect(screen.queryByText(/Selected:/)).not.toBeInTheDocument();
  });

  it("accepts a dropped file", async () => {
    const { deps } = renderForm();
    const zone = screen.getByRole("group", { name: /Drag a file here/ });
    const dropped = file("dropped.txt", 100);
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.drop(zone, { dataTransfer: { files: [dropped] } });
    expect(await screen.findByText("dropped.txt")).toBeInTheDocument();
    expect(deps.createLesson).not.toHaveBeenCalled();
  });
});
