"""The exported contract artifacts must stay in step with the models.

These are the files the frontend generates its Zod types from. If they drift, the two languages
disagree about the contract and nothing catches it until production, so drift fails here.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest
from pydantic import TypeAdapter, ValidationError

from app.schemas.events import LearningEventBatch
from app.schemas.intents import SessionIntentEnvelope
from app.schemas.knowledge_graph import KnowledgeGraph
from app.schemas.render_profile import RenderProfile

BACKEND_DIR = Path(__file__).resolve().parents[2]
CONTRACTS_DIR = BACKEND_DIR.parent / "contracts"
SCHEMA_DIR = CONTRACTS_DIR / "schema"
FIXTURE_DIR = CONTRACTS_DIR / "fixtures"


def _load(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


class TestArtifactsExist:
    @pytest.mark.parametrize(
        "name",
        [
            "knowledge-graph",
            "knowledge-graph-draft",
            "render-profile",
            "session-intent",
            "learning-event",
            "learning-event-batch",
            "event-ingest-result",
        ],
    )
    def test_every_schema_is_exported(self, name: str) -> None:
        assert (SCHEMA_DIR / f"{name}.schema.json").is_file()

    @pytest.mark.parametrize(
        "name",
        [
            "knowledge-graph.valid",
            "knowledge-graph.invalid",
            "learning-event-batch.valid",
            "learning-event-batch.invalid",
            "session-intent.valid",
            "session-intent.invalid",
            "render-profile.default",
            "render-profile.presets",
        ],
    )
    def test_every_fixture_is_exported(self, name: str) -> None:
        assert (FIXTURE_DIR / f"{name}.json").is_file()


class TestNoDrift:
    def test_exported_artifacts_match_the_models(self) -> None:
        """Equivalent to running the exporter in CI."""
        result = subprocess.run(
            [sys.executable, "scripts/export_contracts.py", "--check"],
            cwd=BACKEND_DIR,
            capture_output=True,
            text=True,
            check=False,
        )
        assert result.returncode == 0, (
            "contract artifacts are stale. Run "
            "`uv run python scripts/export_contracts.py`.\n" + result.stderr
        )


class TestFixturesAreHonest:
    """Every fixture must be what its filename claims.

    A fixture labelled invalid that actually parses hands the frontend a test that passes for
    the wrong reason, which is worse than having no test at all.
    """

    def test_the_valid_graph_parses(self) -> None:
        KnowledgeGraph.model_validate(_load(FIXTURE_DIR / "knowledge-graph.valid.json"))

    @pytest.mark.parametrize(
        "case",
        [
            "dangling-quiz-concept",
            "prerequisite-cycle",
            "duplicate-concept-id",
            "mcq-answer-not-in-options",
            "title-over-eighty-characters",
            "no-concepts",
        ],
    )
    def test_each_invalid_graph_is_rejected(self, case: str) -> None:
        payloads = _load(FIXTURE_DIR / "knowledge-graph.invalid.json")
        assert case in payloads, f"fixture {case} is missing"
        with pytest.raises(ValidationError):
            KnowledgeGraph.model_validate(payloads[case])

    def test_the_valid_event_batch_parses(self) -> None:
        LearningEventBatch.model_validate(
            _load(FIXTURE_DIR / "learning-event-batch.valid.json")
        )

    @pytest.mark.parametrize(
        "case",
        ["carries-a-user-id", "empty-batch", "unknown-event-type", "graph-version-zero"],
    )
    def test_each_invalid_event_batch_is_rejected(self, case: str) -> None:
        payloads = _load(FIXTURE_DIR / "learning-event-batch.invalid.json")
        with pytest.raises(ValidationError):
            LearningEventBatch.model_validate(payloads[case])

    def test_valid_intents_parse(self) -> None:
        adapter: TypeAdapter[Any] = TypeAdapter(SessionIntentEnvelope)
        for payload in _load(FIXTURE_DIR / "session-intent.valid.json"):
            adapter.validate_python(payload)

    def test_invalid_intents_are_rejected(self) -> None:
        adapter: TypeAdapter[Any] = TypeAdapter(SessionIntentEnvelope)
        cases = _load(FIXTURE_DIR / "session-intent.invalid.json")
        assert set(cases) == {"unknown-type", "answer-without-value", "bad-rate-direction"}
        for payload in cases.values():
            with pytest.raises(ValidationError):
                adapter.validate_python(payload)

    def test_exported_profiles_round_trip(self) -> None:
        default = _load(FIXTURE_DIR / "render-profile.default.json")
        assert RenderProfile.model_validate(default) == RenderProfile()

        for name, payload in _load(FIXTURE_DIR / "render-profile.presets.json").items():
            profile = RenderProfile.model_validate(payload)
            assert profile.preset == name


class TestSchemaShape:
    def test_schemas_use_camel_case_property_names(self) -> None:
        """The wire format is camelCase, matching the TypeScript contract."""
        graph = _load(SCHEMA_DIR / "knowledge-graph.schema.json")
        assert "lessonId" in graph["properties"]
        assert "quizItems" in graph["properties"]
        assert "lesson_id" not in graph["properties"]

        concept = graph["$defs"]["Concept"]["properties"]
        assert {"sectionId", "keyTerm", "visualHint"} <= set(concept)

    def test_unknown_properties_are_disallowed(self) -> None:
        """Stricter than Zod's default stripping. Recorded in PRD section 9.1."""
        profile = _load(SCHEMA_DIR / "render-profile.schema.json")
        assert profile.get("additionalProperties") is False
