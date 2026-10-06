"""Cost estimation.

Rates are configuration, never inlined at a call site, and the model is identified by the id
actually used rather than by tier, so a tier remapping cannot silently change what a job is
believed to have cost.

Prices change. An unknown model costs zero here and logs a warning rather than guessing: a
plausible-looking invented number in a cost report is worse than an obvious gap, because the
gap gets fixed and the invention gets trusted.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.ai.types import TokenUsage
from app.core.logging import get_logger

logger = get_logger(__name__)


@dataclass(frozen=True, slots=True)
class ModelRates:
    """US dollars per million tokens."""

    input_per_mtok: float
    output_per_mtok: float
    cached_input_per_mtok: float = 0.0

    def cost(self, usage: TokenUsage) -> float:
        million = 1_000_000
        return (
            usage.input_tokens * self.input_per_mtok
            + usage.cache_creation_tokens * self.input_per_mtok
            + usage.cache_read_tokens * self.cached_input_per_mtok
            + usage.output_tokens * self.output_per_mtok
        ) / million


# Populated from configuration at startup. Shipping an empty table is deliberate: the model
# ids come from LLM_MODEL_HEAVY and LLM_MODEL_FAST, so hardcoding a price list here would be
# guessing at which models a deployment uses and at what they cost on its contract.
_RATES: dict[str, ModelRates] = {}
_warned: set[str] = set()


def register_rates(model: str, rates: ModelRates) -> None:
    _RATES[model] = rates


def load_rates(table: dict[str, ModelRates]) -> None:
    _RATES.clear()
    _RATES.update(table)
    _warned.clear()


def estimate_cost(model: str, usage: TokenUsage) -> float:
    rates = _RATES.get(model)
    if rates is None:
        if model not in _warned:
            _warned.add(model)
            logger.warning(
                "llm_pricing_unknown",
                extra={
                    "model": model,
                    "detail": (
                        "no rates registered; cost recorded as 0. Register rates so cost "
                        "reporting against the PRD 6.2 budget is meaningful."
                    ),
                },
            )
        return 0.0
    return rates.cost(usage)


def known_models() -> list[str]:
    return sorted(_RATES)
