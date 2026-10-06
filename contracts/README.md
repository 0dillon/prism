# Prism shared contracts

Language-neutral definitions of the data structures that cross the boundary between the Prism
backend and any client. Generated, never hand-edited.

| Path | Contents |
| --- | --- |
| `schema/` | JSON Schema for each contract model, in the camelCase the wire uses |
| `fixtures/` | Golden payloads: `*.valid.json` must parse, `*.invalid.json` must not |

## Why this directory exists

[`PRISM_PRD.md`](../PRISM_PRD.md) section 0.2 makes Zod schemas the source of truth for all
structured data, which assumes a TypeScript backend. This backend is Python, so maintaining a
second hand-written definition would mean two sources of truth that drift apart silently — and
a drift in, say, a numeric bound or a default is exactly the kind of thing that produces a bug
nobody can reproduce.

Instead:

```
app/schemas/*.py  (Pydantic, authoritative on the server)
        |
        v
contracts/schema/*.json   (JSON Schema, language-neutral)
        |
        v
frontend Zod/TypeScript types  (generated, not transcribed)
```

Both sides validate the same fixtures. A payload that one accepts and the other rejects is a
contract break and shows up as a failing test.

## Regenerating

```bash
cd backend
uv run python scripts/export_contracts.py            # write
uv run python scripts/export_contracts.py --check    # fail if stale (CI)
```

`backend/tests/contract/test_exported_artifacts.py` runs `--check`, so stale artifacts fail the
normal test run. The exporter also refuses to write if any fixture is mislabelled — an
"invalid" payload that actually parses would give the frontend a test that passes for the
wrong reason.

## For frontend consumers

Generate types from `schema/`, then run both fixture sets through them:

- every payload in a `*.valid.json` file must parse;
- every payload in a `*.invalid.json` file must be rejected. The keys name the rule being
  tested (`prerequisite-cycle`, `mcq-answer-not-in-options`, `carries-a-user-id`), so a
  failure says which rule broke.

## Contract notes

Three things are worth knowing before implementing against these schemas.

**Unknown properties are rejected.** `additionalProperties: false` throughout. This is stricter
than Zod's default, which strips unknown keys silently. A renamed or misspelled field should
produce a 422 naming the field rather than data that quietly disappears between two languages.
Recorded as a deliberate deviation in PRD section 9.1.

**A valid `knowledge-graph` is referentially complete.** Parsing enforces more than field
shapes: unique ids, every `quizItems[].conceptId` resolving to a real concept, every
`sectionId` and prerequisite resolving, no prerequisite cycles, and every multiple-choice item
having exactly one option equal to its `answer`. That last one is a correctness rule, not a
quality rule — PRD section 6.2 grades multiple choice on the client by comparing the chosen
option against `answer`, so an item without a matching option can never be answered correctly
and would corrupt mastery. Use `knowledge-graph-draft` for in-progress graphs, where these
problems are reported to a teacher as findings instead.

**Learning events carry no user id.** The authenticated principal is taken from the verified
token and stamped server-side, then enforced again by row-level security. Sending a `userId`
is rejected rather than ignored.
