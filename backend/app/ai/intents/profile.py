"""Turning a learner's description of their needs into profile settings (PRD 5.4A, CE-4).

The invariant this module exists to guarantee: **a failed parse never changes the stored
profile.** Not "usually does not" - there is no code path through here that half-applies a
patch. The model proposes; the server merges into a copy, validates the whole result, and only
then returns something the caller may store.

That matters more than it might appear. A learner describing what helps them learn has
usually just spent effort getting their settings right. Losing those because one request was
ambiguous, or because the provider was having a bad minute, is a worse failure than not
understanding the request at all.

Everything the model cannot do is reported rather than silently dropped. PRD CE-4 requires a
clear "I can't do that yet", and PRD 5.4A records those requests in `unmet_needs` so the
product can grow to cover them.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from app.ai.adapters import profile_patch_to_mapping
from app.ai.errors import LlmError
from app.ai.gateway import LlmGateway
from app.ai.prompts.profile import PARSE_NEEDS_SYSTEM, build_parse_needs_user_turn
from app.ai.schemas import ProfileParseOut
from app.ai.types import Prompt, UsageContext
from app.core.logging import get_logger
from app.domain.profiles.merge import ProfilePatchError, deep_merge_profile
from app.schemas.render_profile import RenderProfile

logger = get_logger(__name__)

# Long enough for someone to describe how they learn, short enough that the endpoint is not a
# way to push arbitrary text through a model on someone else's bill (brief section 11).
MAX_REQUEST_CHARACTERS = 1000


@dataclass(slots=True)
class ProfileParseResult:
    """What the caller should store and what it should tell the learner."""

    profile: RenderProfile
    changed: bool
    explanation: str
    unsupported: list[str] = field(default_factory=list)
    patch: dict[str, object] = field(default_factory=dict)

    @property
    def should_record_unmet_need(self) -> bool:
        return bool(self.unsupported)


class ProfileParser:
    def __init__(self, gateway: LlmGateway) -> None:
        self._gateway = gateway

    async def parse(
        self,
        *,
        request_text: str,
        current: RenderProfile,
        context: UsageContext | None = None,
    ) -> ProfileParseResult:
        """Interpret `request_text` against `current`.

        Never raises for an ordinary failure. An unparseable request, an invalid patch, and a
        provider outage all produce a result carrying the unchanged profile and an explanation
        the learner can act on - because every one of those is a situation where the right
        outcome is "nothing changed, here is why", not an error page.
        """
        text = request_text.strip()
        if not text:
            return ProfileParseResult(
                profile=current,
                changed=False,
                explanation="Tell me what would help, and I'll set things up.",
            )

        if len(text) > MAX_REQUEST_CHARACTERS:
            text = text[:MAX_REQUEST_CHARACTERS]

        prompt = Prompt(
            system=PARSE_NEEDS_SYSTEM,
            user=build_parse_needs_user_turn(
                request_text=text,
                current_profile_json=current.model_dump_json(by_alias=True, indent=2),
            ),
        )

        try:
            result = await self._gateway.generate_structured(
                schema=ProfileParseOut,
                prompt=prompt,
                tier="fast",
                operation="profile.parse",
                context=context or UsageContext(operation="profile.parse"),
                max_output_tokens=1200,
            )
        except LlmError as exc:
            # PRD 6.5 graceful degradation: the learner keeps their settings and is told
            # plainly that this particular feature is unavailable, rather than seeing an error.
            logger.warning(
                "profile_parse_unavailable", extra={"failure": type(exc).__name__}
            )
            return ProfileParseResult(
                profile=current,
                changed=False,
                explanation=(
                    "I couldn't work that out just now, so nothing has changed. "
                    "You can set this yourself in Settings, or try again in a moment."
                ),
            )

        parsed: ProfileParseOut = result.value
        patch = profile_patch_to_mapping(parsed.patch)
        unsupported = [item.strip() for item in parsed.unsupported if item.strip()]

        if not patch:
            return ProfileParseResult(
                profile=current,
                changed=False,
                explanation=parsed.explanation.strip()
                or "I couldn't find a setting for that yet, so nothing has changed.",
                unsupported=unsupported,
            )

        try:
            updated = deep_merge_profile(current, patch)
        except ProfilePatchError as exc:
            # The model proposed something invalid. The existing profile is returned
            # untouched - this is the path the central invariant is about.
            logger.warning(
                "profile_patch_rejected",
                extra={"problems": exc.problems, "operation": "profile.parse"},
            )
            return ProfileParseResult(
                profile=current,
                changed=False,
                explanation=(
                    "I couldn't apply that change, so your settings are unchanged. "
                    "Try describing it a different way."
                ),
                unsupported=unsupported,
            )

        # Editing settings makes a profile the learner's own rather than a named starting
        # point, unless they explicitly asked for a different preset.
        if "preset" not in patch and updated.preset == current.preset:
            updated = updated.model_copy(update={"preset": "custom"})

        return ProfileParseResult(
            profile=updated,
            changed=updated != current,
            explanation=parsed.explanation.strip() or "I've updated your settings.",
            unsupported=unsupported,
            patch=patch,
        )
