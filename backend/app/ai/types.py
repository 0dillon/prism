"""Vendor-neutral types for the LLM gateway.

Nothing here mentions a provider. Swapping vendors changes an implementation of
:class:`LlmProvider` and nothing above it.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Protocol
from uuid import UUID

# PRD 6.2: two tiers behind one interface. `heavy` for extraction and merge, `fast` for
# intents, grading, variants and grounding checks.
Tier = Literal["heavy", "fast"]

Outcome = Literal["ok", "invalid_output", "refusal", "timeout", "rate_limited", "error"]


@dataclass(frozen=True, slots=True)
class Prompt:
    """A system instruction and a user turn.

    Split deliberately. The system text is frozen per operation so it can be prompt-cached,
    and - more importantly - it is the only channel carrying instructions. Untrusted document
    content always goes in the user turn, inside delimiters.
    """

    system: str
    user: str


@dataclass(frozen=True, slots=True)
class TokenUsage:
    """Token counts for one attempt.

    `input_tokens` is the uncached remainder only. Total prompt volume is the sum of all three
    input fields, which is what :meth:`total_input` exists to stop anyone forgetting: a cost
    report that sums `input_tokens` alone understates a well-cached job by most of its volume,
    and would make PRD 6.2's budget look met when it is not.
    """

    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_creation_tokens: int = 0

    @property
    def total_input(self) -> int:
        return self.input_tokens + self.cache_read_tokens + self.cache_creation_tokens

    def __add__(self, other: TokenUsage) -> TokenUsage:
        return TokenUsage(
            input_tokens=self.input_tokens + other.input_tokens,
            output_tokens=self.output_tokens + other.output_tokens,
            cache_read_tokens=self.cache_read_tokens + other.cache_read_tokens,
            cache_creation_tokens=self.cache_creation_tokens + other.cache_creation_tokens,
        )


@dataclass(frozen=True, slots=True)
class ProviderResponse:
    """One raw provider reply, before validation."""

    text: str
    usage: TokenUsage
    model: str
    truncated: bool = False
    refusal: str | None = None


@dataclass(frozen=True, slots=True)
class StructuredRequest:
    """What a provider needs in order to return schema-conforming JSON."""

    prompt: Prompt
    schema_name: str
    json_schema: dict[str, Any]
    max_output_tokens: int
    temperature: float | None = None
    # Prior turns for the corrective retry: the invalid output, and why it was invalid.
    correction: tuple[str, str] | None = None


@dataclass(frozen=True, slots=True)
class UsageContext:
    """Who and what a call is attributable to, for cost reporting and spend caps."""

    operation: str
    user_id: UUID | None = None
    org_id: UUID | None = None
    lesson_id: UUID | None = None
    job_id: UUID | None = None


@dataclass(frozen=True, slots=True)
class UsageRecord:
    """One attempt, as recorded."""

    context: UsageContext
    tier: Tier
    provider: str
    model: str
    attempt: int
    outcome: Outcome
    usage: TokenUsage
    latency_ms: int
    cost_usd: float
    request_id: str | None = None


@dataclass(slots=True)
class GenerationResult:
    """A validated model answer plus what it cost to obtain."""

    value: Any
    usage: TokenUsage = field(default_factory=TokenUsage)
    cost_usd: float = 0.0
    attempts: int = 1
    model: str = ""


class LlmProvider(Protocol):
    """The seam. One implementation per vendor; nothing above this knows which is in use."""

    name: str

    async def generate_structured(
        self, request: StructuredRequest, *, model: str, timeout_seconds: float
    ) -> ProviderResponse:
        """Return schema-conforming JSON text, or raise from `app.ai.errors`.

        Implementations translate vendor exceptions into the shared taxonomy. That translation
        is the whole job: everything above depends on the taxonomy, never on an SDK's types.
        """
        ...


class UsageRecorder(Protocol):
    """Where usage records go. A Protocol so the gateway has no database dependency."""

    async def record(self, record: UsageRecord) -> None: ...
