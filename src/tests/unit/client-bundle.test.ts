import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A browser bundle must not contain server code. Importing a module that reaches
 * next/headers or the Supabase server clients from a "use client" file builds fine in tests and
 * type checks, then fails the production build. This test follows the real imports to find it
 * sooner: it lists every client file that can reach a server-only module, and the path it takes.
 */

const SRC = join(process.cwd(), "src");

/** Modules that only run on the server. Reaching one from a client file is the bug. */
const SERVER_ROOTS = [
  "next/headers",
  "server-only",
  "node:fs",
  "node:crypto",
  "@/lib/supabase/server",
  "@/lib/supabase/admin",
];

interface Import {
  from: string;
  /** False for `import type` and for imports whose every specifier is a type. */
  value: boolean;
}

/** Imports and re-exports in a source file. Type-only ones are erased by the compiler. */
export function importsOf(source: string): Import[] {
  const found: Import[] = [];
  const pattern = /(?:^|\n)\s*(import|export)\s+(type\s+)?([^;'"]*?)\s*from\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) {
    const [, , typeOnly, clause, from] = match;
    if (typeOnly) {
      found.push({ from, value: false });
      continue;
    }
    // `{ type A, type B }` has no value left after the types are erased.
    const named = clause.match(/\{([^}]*)\}/)?.[1];
    const outsideBraces = clause.replace(/\{[^}]*\}/, "").replace(/[,\s*]|as\s+\w+/g, "");
    const hasDefaultOrNamespace = outsideBraces.length > 0 || /\*\s*as\s+\w+/.test(clause);
    const hasValueSpecifier =
      named !== undefined &&
      named
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .some((s) => !s.startsWith("type "));
    found.push({ from, value: hasDefaultOrNamespace || hasValueSpecifier });
  }
  for (const match of source.matchAll(/(?:^|\n)\s*import\s+["']([^"']+)["']/g)) {
    found.push({ from: match[1], value: true });
  }
  return found;
}

/** Client files that reach a server-only module through value imports, with the chain. */
export function findServerLeaks(files: Map<string, string>): string[] {
  const resolveImport = (fromFile: string, spec: string): string | null => {
    const base = spec.startsWith("@/")
      ? join("src", spec.slice(2))
      : spec.startsWith(".")
        ? join(dirname(fromFile), spec)
        : null;
    if (!base) return null;
    const normalized = base.replace(/\\/g, "/");
    for (const candidate of [
      normalized,
      `${normalized}.ts`,
      `${normalized}.tsx`,
      `${normalized}/index.ts`,
      `${normalized}/index.tsx`,
    ]) {
      if (files.has(candidate)) return candidate;
    }
    return null;
  };

  const isServerRoot = (spec: string) => SERVER_ROOTS.includes(spec);

  // For each file, the chain of files to a server root, or null.
  const memo = new Map<string, string[] | null>();
  const chainTo = (file: string, seen: Set<string>): string[] | null => {
    if (memo.has(file)) return memo.get(file)!;
    if (seen.has(file)) return null;
    seen.add(file);
    let result: string[] | null = null;
    for (const imp of importsOf(files.get(file) ?? "")) {
      if (!imp.value) continue;
      if (isServerRoot(imp.from)) {
        result = [file, imp.from];
        break;
      }
      const target = resolveImport(file, imp.from);
      if (!target) continue;
      // A server action file is a boundary: a client component gets a reference to it, never its code.
      if (/^\s*["']use server["']/.test(files.get(target) ?? "")) continue;
      const below = chainTo(target, seen);
      if (below) {
        result = [file, ...below];
        break;
      }
    }
    memo.set(file, result);
    return result;
  };

  const leaks: string[] = [];
  for (const [file, source] of files) {
    if (!/^\s*["']use client["']/.test(source)) continue;
    const chain = chainTo(file, new Set());
    if (chain) leaks.push(chain.join(" -> "));
  }
  return leaks;
}

function readSource(dir: string, files = new Map<string, string>()): Map<string, string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) readSource(path, files);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.d\.ts$/.test(entry)) {
      files.set(relative(process.cwd(), path).replace(/\\/g, "/"), readFileSync(path, "utf8"));
    }
  }
  return files;
}

describe("importsOf", () => {
  it("sees value imports, and ignores type-only ones", () => {
    const found = importsOf(`
      import { a } from "./a";
      import type { B } from "./b";
      import { type C, type D } from "./c";
      import { type E, f } from "./e";
      import g from "./g";
      import * as h from "./h";
      import "./side-effect";
      export { i } from "./i";
      export type { J } from "./j";
    `);
    expect(found.map((i) => [i.from, i.value])).toEqual([
      ["./a", true],
      ["./b", false],
      ["./c", false],
      ["./e", true],
      ["./g", true],
      ["./h", true],
      ["./i", true],
      ["./j", false],
      ["./side-effect", true],
    ]);
  });
});

describe("findServerLeaks", () => {
  const files = (entries: Record<string, string>) => new Map(Object.entries(entries));

  it("finds a client file that reaches the server through a chain of imports", () => {
    const leaks = findServerLeaks(
      files({
        "src/app/Card.tsx": `"use client";\nimport { level } from "@/lib/spend";`,
        "src/lib/spend.ts": `import { fail } from "@/lib/http";\nexport const level = 1;`,
        "src/lib/http.ts": `import { cookies } from "next/headers";\nexport const fail = 1;`,
      }),
    );
    expect(leaks).toEqual([
      "src/app/Card.tsx -> src/lib/spend.ts -> src/lib/http.ts -> next/headers",
    ]);
  });

  it("allows a client file that imports only the types of a server module", () => {
    expect(
      findServerLeaks(
        files({
          "src/app/Card.tsx": `"use client";\nimport type { Spend } from "@/lib/spend";\nimport { type Other } from "@/lib/spend";`,
          "src/lib/spend.ts": `import { cookies } from "next/headers";`,
        }),
      ),
    ).toEqual([]);
  });

  it("does not flag a server file, or a client file that stays on pure modules", () => {
    expect(
      findServerLeaks(
        files({
          "src/app/page.tsx": `import { cookies } from "next/headers";`,
          "src/app/Card.tsx": `"use client";\nimport { level } from "../lib/pure";`,
          "src/lib/pure.ts": `export const level = 1;`,
        }),
      ),
    ).toEqual([]);
  });

  it("follows a re-export", () => {
    expect(
      findServerLeaks(
        files({
          "src/app/Card.tsx": `"use client";\nimport { x } from "@/lib/barrel";`,
          "src/lib/barrel.ts": `export { x } from "./server-thing";`,
          "src/lib/server-thing.ts": `import "server-only";`,
        }),
      ),
    ).toHaveLength(1);
  });

  it("treats a server action file as a boundary, as the framework does", () => {
    expect(
      findServerLeaks(
        files({
          "src/app/Form.tsx": `"use client";\nimport { save } from "./actions";`,
          "src/app/actions.ts": `"use server";\nimport { cookies } from "next/headers";`,
        }),
      ),
    ).toEqual([]);
  });

  it("copes with an import cycle", () => {
    expect(
      findServerLeaks(
        files({
          "src/app/Card.tsx": `"use client";\nimport { a } from "@/lib/a";`,
          "src/lib/a.ts": `import { b } from "./b";`,
          "src/lib/b.ts": `import { a } from "./a";`,
        }),
      ),
    ).toEqual([]);
  });
});

describe("the real source", () => {
  it("has no client component that can reach server-only code", () => {
    expect(findServerLeaks(readSource(SRC))).toEqual([]);
  });
});
