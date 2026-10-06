// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownBody, parseBlocks } from "@/renderers/shared/markdown";
import { expectNoAxeViolations } from "../a11y";

describe("parseBlocks", () => {
  it("makes paragraphs from blank-line separated text and joins wrapped lines", () => {
    expect(parseBlocks("One two\nthree.\n\nFour.")).toEqual([
      { kind: "paragraph", text: "One two three." },
      { kind: "paragraph", text: "Four." },
    ]);
  });

  it("reads bullet lists with any of the three markers", () => {
    expect(parseBlocks("- a\n* b\n+ c")).toEqual([
      { kind: "list", ordered: false, items: ["a", "b", "c"] },
    ]);
  });

  it("reads numbered lists", () => {
    expect(parseBlocks("1. first\n2) second")).toEqual([
      { kind: "list", ordered: true, items: ["first", "second"] },
    ]);
  });

  it("starts a new list when the kind changes", () => {
    expect(parseBlocks("- a\n1. b")).toEqual([
      { kind: "list", ordered: false, items: ["a"] },
      { kind: "list", ordered: true, items: ["b"] },
    ]);
  });

  it("ends a paragraph where a list starts", () => {
    expect(parseBlocks("Steps:\n- a\n- b")).toEqual([
      { kind: "paragraph", text: "Steps:" },
      { kind: "list", ordered: false, items: ["a", "b"] },
    ]);
  });

  it("continues a list item on an indented wrapped line", () => {
    expect(parseBlocks("- first part\n  and more\n- second")).toEqual([
      { kind: "list", ordered: false, items: ["first part and more", "second"] },
    ]);
  });

  it("turns headings into bold paragraphs, so they cannot disturb the page's heading order", () => {
    expect(parseBlocks("## Why\nBecause.")).toEqual([
      { kind: "paragraph", text: "**Why**" },
      { kind: "paragraph", text: "Because." },
    ]);
  });

  it("copes with Windows line endings, empty input and only whitespace", () => {
    expect(parseBlocks("a\r\n\r\nb")).toHaveLength(2);
    expect(parseBlocks("")).toEqual([]);
    expect(parseBlocks("  \n \n")).toEqual([]);
  });

  it("does not treat a hyphen inside a sentence or a number as a list", () => {
    expect(parseBlocks("Well-known fact. 3.5 litres.")).toEqual([
      { kind: "paragraph", text: "Well-known fact. 3.5 litres." },
    ]);
  });
});

describe("MarkdownBody", () => {
  it("renders paragraphs and lists with the right elements", () => {
    render(<MarkdownBody markdown={"Intro.\n\n- one\n- two\n\n1. a\n2. b"} />);
    expect(screen.getByText("Intro.").tagName).toBe("P");
    expect(screen.getAllByRole("list")).toHaveLength(2);
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
  });

  it("renders bold, italic and code", () => {
    const { container } = render(
      <MarkdownBody markdown="A **bold** and *slanted* and `code` word." />,
    );
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("em")?.textContent).toBe("slanted");
    expect(container.querySelector("code")?.textContent).toBe("code");
    expect(container.textContent).toBe("A bold and slanted and code word.");
  });

  it("leaves a lone asterisk or underscore alone", () => {
    const { container } = render(<MarkdownBody markdown="2 * 3 = 6 and snake_case_name stays" />);
    expect(container.textContent).toBe("2 * 3 = 6 and snake_case_name stays");
    expect(container.querySelector("em")).toBeNull();
  });

  it("italicises an underscore pair at the edge of words but not inside one", () => {
    const { container } = render(<MarkdownBody markdown="Say _this_ but not snake_case_name." />);
    expect(container.querySelector("em")?.textContent).toBe("this");
    expect(container.textContent).toBe("Say this but not snake_case_name.");
  });

  it("never inserts HTML from the text", () => {
    const { container } = render(
      <MarkdownBody
        markdown={'<img src=x onerror="alert(1)"> <script>alert(1)</script> **<b>hi</b>**'}
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
  });

  it("never makes a heading element, however many # it is given", () => {
    const { container } = render(<MarkdownBody markdown={"# One\n## Two\n###### Six"} />);
    expect(container.querySelector("h1,h2,h3,h4,h5,h6")).toBeNull();
    expect(container.querySelectorAll("strong")).toHaveLength(3);
  });

  it("renders nothing for an empty body", () => {
    const { container } = render(<MarkdownBody markdown="" />);
    expect(container.textContent).toBe("");
  });

  it("has no axe violations", async () => {
    const { container } = render(
      <MarkdownBody markdown={"Text with **bold**.\n\n- a\n- b\n\n1. c"} />,
    );
    await expectNoAxeViolations(container);
  });
});
