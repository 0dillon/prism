"""Architectural rules, enforced by introspection rather than by review.

Each rule here protects an invariant that erodes one convenient shortcut at a time. A comment
asking people not to do something is not a control; a failing build is.
"""

from __future__ import annotations

import ast
import importlib
import pkgutil
from pathlib import Path
from typing import ClassVar

import pytest
from pydantic import BaseModel

import app

APP_DIR = Path(app.__file__).resolve().parent


def _module_imports(path: Path) -> set[str]:
    """Every module name imported by a file, as written."""
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            names.add(node.module)
    return names


def _python_files(*relative: str) -> list[Path]:
    roots = [APP_DIR / part for part in relative] if relative else [APP_DIR]
    return sorted(
        path
        for root in roots
        if root.exists()
        for path in root.rglob("*.py")
    )


def _all_app_models() -> list[type[BaseModel]]:
    models: list[type[BaseModel]] = []
    for info in pkgutil.walk_packages(app.__path__, prefix="app."):
        module = importlib.import_module(info.name)
        for value in vars(module).values():
            if (
                isinstance(value, type)
                and issubclass(value, BaseModel)
                and value is not BaseModel
                and value.__module__ == info.name
            ):
                models.append(value)
    return models


class TestNoClientSuppliedIdentity:
    """Brief section 8: the principal comes from the verified token, never from the client."""

    def test_no_model_declares_a_user_identity_field(self) -> None:
        offenders: list[str] = []
        # The verified principal itself legitimately holds a user id; it is constructed from a
        # checked signature, not from request data.
        exempt = {"app.auth.identity"}

        for model in _all_app_models():
            if model.__module__ in exempt:
                continue
            for field_name in model.model_fields:
                if field_name.lower().replace("_", "") in {"userid", "ownerid", "studentid"}:
                    offenders.append(f"{model.__module__}.{model.__name__}.{field_name}")

        assert not offenders, (
            "these models accept a client-supplied identity, which would let a caller act as "
            f"another learner: {offenders}"
        )

    def test_the_learning_event_model_specifically_has_no_user_id(self) -> None:
        """Called out separately because it is the highest-value target in the product.

        PRD task P5-02. If a learner could attribute events to someone else, they could
        corrupt another student's mastery record.
        """
        from app.schemas.events import LearningEvent, LearningEventBatch

        assert "user_id" not in LearningEvent.model_fields
        assert "user_id" not in LearningEventBatch.model_fields


class TestPrivilegedAccessIsContained:
    """Brief section 10: service-role access is root access to application data."""

    ALLOWED: ClassVar[set[str]] = {
        "app/db/privileged.py",
        # Add a module here only alongside an entry in docs/privileged-access.md, and expect
        # the ruff banned-api allowlist in pyproject.toml to need the same edit.
        "app/repositories/privileged/rate_limits.py",
    }

    def test_only_allowlisted_modules_import_the_privileged_session(self) -> None:
        importers = {
            path.relative_to(APP_DIR.parent).as_posix()
            for path in _python_files()
            if "app.db.privileged" in _module_imports(path)
        }
        unexpected = importers - self.ALLOWED
        assert not unexpected, (
            "privileged database access must stay in an allowlisted module; "
            f"unexpected importers: {sorted(unexpected)}"
        )

    def test_the_privileged_session_requires_an_explicit_reason(self) -> None:
        """No default, so every call site answers 'why is this bypassing RLS?' in the open."""
        import inspect

        from app.db.privileged import privileged_session

        signature = inspect.signature(privileged_session.__wrapped__)  # type: ignore[attr-defined]
        reason = signature.parameters["reason"]
        assert reason.default is inspect.Parameter.empty


class TestDomainLayerIsPure:
    """Business rules must be testable without infrastructure, and must stay deterministic."""

    FORBIDDEN: ClassVar[set[str]] = {"asyncpg", "httpx", "openai", "fastapi", "starlette"}

    def test_domain_modules_perform_no_io(self) -> None:
        offenders: dict[str, set[str]] = {}
        for path in _python_files("domain"):
            leaked = {
                name
                for name in _module_imports(path)
                if name.split(".")[0] in self.FORBIDDEN
            }
            if leaked:
                offenders[path.name] = leaked
        assert not offenders, f"domain logic must not depend on infrastructure: {offenders}"

    def test_domain_modules_do_not_import_the_database(self) -> None:
        offenders = [
            path.name
            for path in _python_files("domain")
            if any(name.startswith("app.db") for name in _module_imports(path))
        ]
        assert not offenders, offenders


class TestProviderSdksStayBehindTheGateway:
    """Brief section 24 and 72: no business logic depends on a particular vendor."""

    ALLOWED_OPENAI_IMPORTERS_PREFIX = ("app/ai/providers/", "app/speech/providers/")

    def test_the_openai_sdk_is_imported_only_by_provider_implementations(self) -> None:
        offenders = [
            path.relative_to(APP_DIR.parent).as_posix()
            for path in _python_files()
            if any(name.split(".")[0] == "openai" for name in _module_imports(path))
            and not path.relative_to(APP_DIR.parent)
            .as_posix()
            .startswith(self.ALLOWED_OPENAI_IMPORTERS_PREFIX)
        ]
        assert not offenders, (
            "provider SDK calls must stay behind the gateway interface so the backend remains "
            f"replaceable at the infrastructure boundary: {offenders}"
        )

    def test_api_routes_do_not_import_provider_sdks_or_the_database_driver(self) -> None:
        offenders: dict[str, set[str]] = {}
        for path in _python_files("api"):
            leaked = {
                name
                for name in _module_imports(path)
                if name.split(".")[0] in {"openai", "asyncpg", "stripe"}
            }
            if leaked:
                offenders[path.name] = leaked
        assert not offenders, (
            f"route handlers must go through services and repositories: {offenders}"
        )


class TestErrorHandling:
    def test_no_module_swallows_exceptions_silently(self) -> None:
        """A bare `except: pass` turns a failure into wrong behaviour with no trace."""
        offenders: list[str] = []
        for path in _python_files():
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            for node in ast.walk(tree):
                if isinstance(node, ast.ExceptHandler) and len(node.body) == 1:
                    only = node.body[0]
                    if isinstance(only, ast.Pass):
                        offenders.append(f"{path.name}:{node.lineno}")
        assert not offenders, f"silent exception swallowing: {offenders}"


@pytest.mark.parametrize(
    "package",
    ["api", "core", "auth", "db", "schemas", "domain", "repositories", "ai", "ingestion"],
)
def test_every_package_is_importable(package: str) -> None:
    """Catches a circular import or a typo before it shows up as a confusing runtime error."""
    importlib.import_module(f"app.{package}")
