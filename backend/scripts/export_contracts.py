"""Export the shared contract artifacts to `contracts/`.

The PRD makes Zod the schema source of truth (section 0.2), but this backend is Python. Rather
than maintain two hand-written definitions that quietly drift, the Pydantic models are
authoritative on this side and export a language-neutral artifact:

* `contracts/schema/*.json`  - JSON Schema, in the camelCase the wire uses.
* `contracts/fixtures/*.json` - golden payloads, both valid and deliberately invalid.

The frontend generates its Zod/TypeScript types from the schemas and runs the same fixtures
through them. A fixture that one side accepts and the other rejects is a contract break, and
it shows up as a failing test rather than as a bug in production.

Run with `uv run python scripts/export_contracts.py`. CI runs `--check` to fail on drift.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

from pydantic import BaseModel, TypeAdapter

from app.domain.profiles.presets import all_presets
from app.schemas.events import EventIngestResult, LearningEvent, LearningEventBatch
from app.schemas.intents import SessionIntentEnvelope
from app.schemas.knowledge_graph import DraftKnowledgeGraph, KnowledgeGraph
from app.schemas.render_profile import RenderProfile

CONTRACTS_DIR = Path(__file__).resolve().parents[2] / "contracts"
SCHEMA_DIR = CONTRACTS_DIR / "schema"
FIXTURE_DIR = CONTRACTS_DIR / "fixtures"

EXPORTED_MODELS: dict[str, type[BaseModel]] = {
    "knowledge-graph": KnowledgeGraph,
    "knowledge-graph-draft": DraftKnowledgeGraph,
    "render-profile": RenderProfile,
    "session-intent": SessionIntentEnvelope,
    "learning-event": LearningEvent,
    "learning-event-batch": LearningEventBatch,
    "event-ingest-result": EventIngestResult,
}


# --------------------------------------------------------------------------
# Golden fixtures
# --------------------------------------------------------------------------
VALID_GRAPH: dict[str, Any] = {
    "schemaVersion": 1,
    "lessonId": "lesson_01HZX000000000000000000000",
    "title": "The Water Cycle",
    "overview": "How water moves between the ground, the air and the clouds.",
    "language": "en",
    "sections": [
        {"id": "s_01HZX0000000000000000000A", "title": "Evaporation", "order": 0},
        {"id": "s_01HZX0000000000000000000B", "title": "Condensation", "order": 1},
    ],
    "concepts": [
        {
            "id": "c_01HZX0000000000000000001",
            "sectionId": "s_01HZX0000000000000000000A",
            "order": 0,
            "title": "Evaporation",
            "summary": "Liquid water becomes vapour when it gains enough energy.",
            "body": "When water absorbs enough energy, molecules escape into the air.",
            "keyTerm": "evaporation",
            "definition": "The change from liquid water to water vapour.",
            "examples": ["A puddle drying in the sun."],
            "prerequisites": [],
            "visualHint": "A puddle with arrows rising from it.",
            "source": {
                "kind": "page",
                "start": 1,
                "end": 1,
                "excerpt": "Water evaporates when it is heated by the sun.",
            },
            "flags": [],
        },
        {
            "id": "c_01HZX0000000000000000002",
            "sectionId": "s_01HZX0000000000000000000B",
            "order": 0,
            "title": "Condensation",
            "summary": "Water vapour cools and becomes liquid droplets again.",
            "body": "As vapour rises it cools, and droplets form around tiny particles.",
            "keyTerm": "condensation",
            "definition": "The change from water vapour to liquid water.",
            "examples": ["Mist forming on a cold window."],
            "prerequisites": ["c_01HZX0000000000000000001"],
            "visualHint": None,
            "source": {
                "kind": "page",
                "start": 2,
                "end": None,
                "excerpt": "As vapour rises and cools, it condenses into droplets.",
            },
            "flags": ["low_confidence"],
        },
    ],
    "quizItems": [
        {
            "id": "q_01HZX0000000000000000001",
            "conceptId": "c_01HZX0000000000000000001",
            "type": "mcq",
            "prompt": "What does water need in order to evaporate?",
            "options": ["Energy", "Gravity", "Pressure"],
            "answer": "Energy",
            "acceptable": [],
            "explanation": "Molecules need energy to escape the liquid.",
            "difficulty": "recall",
            "flags": [],
        },
        {
            "id": "q_01HZX0000000000000000002",
            "conceptId": "c_01HZX0000000000000000002",
            "type": "true_false",
            "prompt": "Condensation turns vapour back into liquid.",
            "options": None,
            "answer": "true",
            "acceptable": [],
            "explanation": "Cooling vapour forms liquid droplets.",
            "difficulty": "recall",
            "flags": [],
        },
        {
            "id": "q_01HZX0000000000000000003",
            "conceptId": "c_01HZX0000000000000000002",
            "type": "short_answer",
            "prompt": "In your own words, what is condensation?",
            "options": None,
            "answer": "Water vapour cooling into liquid droplets.",
            "acceptable": ["vapour turning into water", "gas becoming liquid"],
            "explanation": "Either phrasing describes the same change of state.",
            "difficulty": "apply",
            "flags": [],
        },
    ],
    "transcript": None,
}

# Each invalid fixture isolates exactly one rule, so a failure names the rule that broke.
INVALID_GRAPHS: dict[str, dict[str, Any]] = {
    "dangling-quiz-concept": {
        **VALID_GRAPH,
        "quizItems": [{**VALID_GRAPH["quizItems"][0], "conceptId": "c_does_not_exist"}],
    },
    "prerequisite-cycle": {
        **VALID_GRAPH,
        "concepts": [
            {**VALID_GRAPH["concepts"][0], "prerequisites": ["c_01HZX0000000000000000002"]},
            {**VALID_GRAPH["concepts"][1], "prerequisites": ["c_01HZX0000000000000000001"]},
        ],
    },
    "duplicate-concept-id": {
        **VALID_GRAPH,
        "concepts": [VALID_GRAPH["concepts"][0], VALID_GRAPH["concepts"][0]],
        "quizItems": [],
    },
    "mcq-answer-not-in-options": {
        **VALID_GRAPH,
        "quizItems": [{**VALID_GRAPH["quizItems"][0], "answer": "Sunlight"}],
    },
    "title-over-eighty-characters": {
        **VALID_GRAPH,
        "concepts": [{**VALID_GRAPH["concepts"][0], "title": "x" * 81}],
        "quizItems": [],
    },
    "no-concepts": {**VALID_GRAPH, "concepts": [], "quizItems": []},
}

VALID_EVENT_BATCH: dict[str, Any] = {
    "events": [
        {
            "id": "01HZX3QK9J2W8V5N6M7P8Q9R0S",
            "lessonId": "lesson_01HZX000000000000000000000",
            "graphVersion": 1,
            "type": "lesson_started",
            "conceptId": None,
            "quizItemId": None,
            "correct": None,
            "durationMs": None,
            "layout": "cards",
            "occurredAt": "2026-10-06T10:00:00Z",
        },
        {
            "id": "01HZX3QK9J2W8V5N6M7P8Q9R0T",
            "lessonId": "lesson_01HZX000000000000000000000",
            "graphVersion": 1,
            "type": "quiz_answered",
            "conceptId": "c_01HZX0000000000000000001",
            "quizItemId": "q_01HZX0000000000000000001",
            "correct": True,
            "durationMs": 4200,
            "layout": "cards",
            "occurredAt": "2026-10-06T10:00:30Z",
        },
    ]
}

INVALID_EVENT_BATCHES: dict[str, dict[str, Any]] = {
    "carries-a-user-id": {
        "events": [{**VALID_EVENT_BATCH["events"][0], "userId": "someone-else"}]
    },
    "empty-batch": {"events": []},
    "unknown-event-type": {
        "events": [{**VALID_EVENT_BATCH["events"][0], "type": "learner_gave_up"}]
    },
    "graph-version-zero": {
        "events": [{**VALID_EVENT_BATCH["events"][0], "graphVersion": 0}]
    },
}

VALID_INTENTS: list[dict[str, Any]] = [
    {"intent": {"type": "next"}},
    {"intent": {"type": "repeat"}},
    {"intent": {"type": "simplify"}},
    {"intent": {"type": "quiz_me"}},
    {"intent": {"type": "answer", "value": "Energy"}},
    {"intent": {"type": "go_to", "target": "Condensation"}},
    {"intent": {"type": "set_rate", "direction": "slower"}},
    {"intent": {"type": "change_profile", "request": "one idea at a time"}},
    {"intent": {"type": "question", "text": "Why does it rain?"}},
    {"intent": {"type": "unknown"}},
]

INVALID_INTENTS: dict[str, dict[str, Any]] = {
    "unknown-type": {"intent": {"type": "order_pizza"}},
    "answer-without-value": {"intent": {"type": "answer"}},
    "bad-rate-direction": {"intent": {"type": "set_rate", "direction": "sideways"}},
}


def build_artifacts() -> dict[Path, Any]:
    """Every file this script owns, as path -> JSON-serialisable content."""
    artifacts: dict[Path, Any] = {}

    for name, model in EXPORTED_MODELS.items():
        artifacts[SCHEMA_DIR / f"{name}.schema.json"] = model.model_json_schema(
            by_alias=True, mode="serialization"
        )

    artifacts[FIXTURE_DIR / "knowledge-graph.valid.json"] = VALID_GRAPH
    artifacts[FIXTURE_DIR / "knowledge-graph.invalid.json"] = INVALID_GRAPHS
    artifacts[FIXTURE_DIR / "learning-event-batch.valid.json"] = VALID_EVENT_BATCH
    artifacts[FIXTURE_DIR / "learning-event-batch.invalid.json"] = INVALID_EVENT_BATCHES
    artifacts[FIXTURE_DIR / "session-intent.valid.json"] = VALID_INTENTS
    artifacts[FIXTURE_DIR / "session-intent.invalid.json"] = INVALID_INTENTS

    artifacts[FIXTURE_DIR / "render-profile.default.json"] = RenderProfile().model_dump(
        mode="json", by_alias=True
    )
    artifacts[FIXTURE_DIR / "render-profile.presets.json"] = {
        name: profile.model_dump(mode="json", by_alias=True)
        for name, profile in all_presets().items()
    }
    return artifacts


def _serialize(content: Any) -> str:
    return json.dumps(content, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def _parses(validate: Callable[[Any], object], payload: Any) -> str | None:
    """None when the payload parses, otherwise the reason it did not."""
    try:
        validate(payload)
    except Exception as exc:
        return str(exc)
    return None


def verify_fixtures_are_honest() -> list[str]:
    """Confirm every fixture really is what its filename claims.

    Without this, a fixture labelled "invalid" that actually parses would hand the frontend a
    test that passes for the wrong reason, which is worse than having no test.
    """
    problems: list[str] = []
    intent_adapter: TypeAdapter[Any] = TypeAdapter(SessionIntentEnvelope)

    checks: list[tuple[str, Callable[[Any], object], Any, dict[str, Any] | None]] = [
        ("knowledge-graph", KnowledgeGraph.model_validate, VALID_GRAPH, INVALID_GRAPHS),
        (
            "learning-event-batch",
            LearningEventBatch.model_validate,
            VALID_EVENT_BATCH,
            INVALID_EVENT_BATCHES,
        ),
    ]

    for label, validate, valid_payload, invalid_payloads in checks:
        if (reason := _parses(validate, valid_payload)) is not None:
            problems.append(f"{label}.valid does not parse: {reason}")
        for name, payload in (invalid_payloads or {}).items():
            if _parses(validate, payload) is None:
                problems.append(f"{label}.invalid[{name}] unexpectedly parsed")

    for index, payload in enumerate(VALID_INTENTS):
        if (reason := _parses(intent_adapter.validate_python, payload)) is not None:
            problems.append(f"session-intent.valid[{index}] does not parse: {reason}")

    for name, payload in INVALID_INTENTS.items():
        if _parses(intent_adapter.validate_python, payload) is None:
            problems.append(f"session-intent.invalid[{name}] unexpectedly parsed")

    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="Exit non-zero if the written files differ from what would be generated.",
    )
    args = parser.parse_args()

    problems = verify_fixtures_are_honest()
    if problems:
        for problem in problems:
            sys.stderr.write(f"fixture error: {problem}\n")
        return 2

    artifacts = build_artifacts()

    if args.check:
        stale = [
            path
            for path, content in artifacts.items()
            if not path.exists() or path.read_text(encoding="utf-8") != _serialize(content)
        ]
        if stale:
            sys.stderr.write(
                "contract artifacts are out of date; run "
                "`uv run python scripts/export_contracts.py`:\n"
            )
            for path in stale:
                sys.stderr.write(f"  {path.relative_to(CONTRACTS_DIR.parent)}\n")
            return 1
        return 0

    SCHEMA_DIR.mkdir(parents=True, exist_ok=True)
    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    for path, content in artifacts.items():
        path.write_text(_serialize(content), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
