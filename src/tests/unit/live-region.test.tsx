// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { announce, LiveRegions } from "@/lib/a11y/live-region";

describe("announce", () => {
  it("renders a polite status region and an assertive alert region", () => {
    render(<LiveRegions />);
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
    expect(screen.getByRole("alert")).toHaveAttribute("aria-live", "assertive");
  });

  it("writes polite messages to the status region", () => {
    render(<LiveRegions />);
    act(() => announce("Switched to cards"));
    expect(screen.getByRole("status")).toHaveTextContent("Switched to cards");
    expect(screen.getByRole("alert")).toBeEmptyDOMElement();
  });

  it("writes assertive messages to the alert region", () => {
    render(<LiveRegions />);
    act(() => announce("Upload failed", "assertive"));
    expect(screen.getByRole("alert")).toHaveTextContent("Upload failed");
  });

  it("changes the text when the same message repeats so it is read again", () => {
    render(<LiveRegions />);
    act(() => announce("Correct"));
    const first = screen.getByRole("status").textContent;
    act(() => announce("Correct"));
    const second = screen.getByRole("status").textContent;
    expect(second).not.toBe(first);
    expect(second?.trim()).toBe("Correct");
  });

  it("ignores blank messages", () => {
    render(<LiveRegions />);
    act(() => announce("   "));
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("flushes messages sent before the regions mounted", () => {
    announce("Early message");
    render(<LiveRegions />);
    expect(screen.getByRole("status")).toHaveTextContent("Early message");
  });
});
