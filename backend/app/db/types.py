"""Distinct connection types for the two database identities.

`RlsConnection` and `PrivilegedConnection` are both pooled asyncpg connections at runtime, but
under `mypy --strict` they are not interchangeable. A repository function annotated to take an
`RlsConnection` cannot be handed a privileged one, so "this query runs with row-level security
enforced" becomes a property the type checker verifies rather than a convention a reviewer has
to notice.

This is the first of four layers keeping privileged access contained. The others are the
package split (`app/repositories/` versus `app/repositories/privileged/`), the ruff
`banned-api` allowlist in `pyproject.toml`, and a runtime assertion on `current_user` in each
session factory.

Both alias the pool's connection proxy rather than `asyncpg.Connection`, because that is what
`Pool.acquire()` actually yields.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, NewType

from asyncpg.pool import PoolConnectionProxy

if TYPE_CHECKING:
    from asyncpg import Record

    # Generic in the type stubs, but not parameterised at runtime, so the subscript lives
    # here where only the type checker evaluates it.
    _PooledConnection = PoolConnectionProxy[Record]
else:
    _PooledConnection = PoolConnectionProxy

# Carries an authenticated (or anonymous) identity. Row-level security applies to every
# statement. This is the only connection type the request path should ever see.
RlsConnection = NewType("RlsConnection", _PooledConnection)

# Runs as service_role, which bypasses row-level security entirely. Treat any code holding one
# of these as equivalent to root access to application data.
PrivilegedConnection = NewType("PrivilegedConnection", _PooledConnection)
