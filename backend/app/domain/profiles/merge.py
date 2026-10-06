"""Deep-merging patches into a Render Profile.

This is the only way a profile changes. It matters because of where patches come from: PRD
section 5.4 lets a learner describe their needs in plain language and has an LLM propose a
patch. The model proposes; the server decides. A patch is merged into a copy, the result is
validated in full, and only a valid result replaces the stored profile.

The consequence is the invariant in PRD CE-4 and brief section 28: a failed parse never mutates
the existing profile. There is no path through this module that half-applies a patch.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from pydantic import ValidationError
from pydantic.alias_generators import to_snake

from app.schemas.render_profile import RenderProfile


class ProfilePatchError(ValueError):
    """A patch that cannot be applied. The caller keeps the original profile."""

    def __init__(self, message: str, *, problems: list[str] | None = None) -> None:
        super().__init__(message)
        self.problems = problems or []


def normalize_keys(value: Any) -> Any:
    """Recursively convert camelCase keys to snake_case.

    Patches arrive from the browser and from LLM output in camelCase, matching the TypeScript
    contract; Python field names are snake_case. Normalising first means a patch cannot
    accidentally merge `readingLevel` alongside an existing `reading_level` and leave the
    object with two spellings of one setting.
    """
    if isinstance(value, Mapping):
        return {to_snake(str(key)): normalize_keys(item) for key, item in value.items()}
    if isinstance(value, list):
        return [normalize_keys(item) for item in value]
    return value


def _deep_merge(base: dict[str, Any], patch: Mapping[str, Any]) -> dict[str, Any]:
    """Merge nested mappings; any other value replaces wholesale.

    Lists replace rather than concatenate: a learner asking for different examples means
    "these instead", not "these as well".
    """
    merged = dict(base)
    for key, value in patch.items():
        existing = merged.get(key)
        if isinstance(existing, dict) and isinstance(value, Mapping):
            merged[key] = _deep_merge(existing, value)
        else:
            merged[key] = value
    return merged


def deep_merge_profile(base: RenderProfile, patch: Mapping[str, Any]) -> RenderProfile:
    """Return a new profile with `patch` applied, or raise without touching `base`.

    Raises :class:`ProfilePatchError` when the patch names an unknown setting, or when the
    merged result would be invalid. The caller keeps the original profile in both cases.
    """
    normalized = normalize_keys(patch)
    if not isinstance(normalized, dict):
        raise ProfilePatchError("A profile patch must be an object.")

    # The schema version is the contract's own identity, not a learner preference.
    normalized.pop("schema_version", None)

    candidate = _deep_merge(base.model_dump(mode="json"), normalized)
    try:
        return RenderProfile.model_validate(candidate)
    except ValidationError as exc:
        problems = [
            f"{'.'.join(str(part) for part in error.get('loc', ()))}: {error.get('msg', '')}"
            for error in exc.errors()
        ]
        raise ProfilePatchError(
            "The requested settings are not valid, so your profile was left unchanged.",
            problems=problems,
        ) from exc
