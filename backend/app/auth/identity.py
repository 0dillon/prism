"""The authenticated principal.

This is the only representation of "who is making this request" in the system. It is
constructed solely from a cryptographically verified token. There is no constructor that takes
a user id from a request body, and no request model anywhere declares one — a test in
`tests/arch/` asserts that by introspection, because "never trust a client-supplied user id"
is the kind of rule that erodes one convenient shortcut at a time.
"""

from __future__ import annotations

from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class Identity(BaseModel):
    """A verified Supabase principal."""

    model_config = ConfigDict(frozen=True)

    user_id: UUID = Field(description="The `sub` claim.")
    role: Literal["authenticated"] = Field(
        description=(
            "The JWT role claim. Always 'authenticated': tokens claiming any other role are "
            "rejected during verification, which is what stops a leaked service-role key "
            "from being usable as a request credential."
        )
    )
    session_id: str | None = None
    aal: str | None = Field(default=None, description="Authenticator assurance level.")
    email: str | None = None
    is_anonymous: bool = False
    claims: dict[str, Any] = Field(
        default_factory=dict, description="The full verified payload, filtered before use."
    )

    @property
    def subject(self) -> str:
        return str(self.user_id)

    def __str__(self) -> str:
        # Keeps an accidental f-string in a log line from printing email or raw claims.
        return f"Identity(user_id={self.user_id})"
