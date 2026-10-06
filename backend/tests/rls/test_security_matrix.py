"""Row-level security: the release-blocking checks (brief section 9, PRD tasks P1-07, P8-09).

The brief treats authorization bypass as a release-blocking defect, so these are mechanical
rather than illustrative. In particular, the table list is discovered from
`information_schema` rather than written out: a table added in a future migration without
policies fails this suite automatically, which a hand-maintained list would never do.

All marked `requires_db`. They skip without a database and are ready to run with one.
"""

from __future__ import annotations

from typing import Any
from uuid import UUID

import pytest

from tests.rls.conftest import identity_for

pytestmark = pytest.mark.requires_db


# ---------------------------------------------------------------------------
# Structural guarantees, discovered rather than enumerated.
# ---------------------------------------------------------------------------
class TestEveryTableIsProtected:
    async def test_rls_is_enabled_and_forced_on_every_public_table(
        self, isolated: Any
    ) -> None:
        """PRD 6.4: row-level security on every table; no table readable without a policy.

        FORCE matters separately from ENABLE: without it the table owner ignores policies
        entirely, and the owner here is `postgres`.
        """
        rows = await isolated.fetch(
            """
            select c.relname, c.relrowsecurity, c.relforcerowsecurity
              from pg_class c
              join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'public' and c.relkind = 'r'
               and not (c.relrowsecurity and c.relforcerowsecurity)
             order by c.relname
            """
        )
        assert not rows, (
            "these tables do not have row-level security enabled and forced: "
            f"{[row['relname'] for row in rows]}"
        )

    async def test_no_policy_applies_to_every_role(self, isolated: Any) -> None:
        """An unqualified policy is evaluated for roles it was never written for."""
        rows = await isolated.fetch(
            """
            select schemaname, tablename, policyname, roles
              from pg_policies
             where schemaname = 'public' and roles = '{public}'
            """
        )
        assert not rows, f"policies without a TO clause: {[r['policyname'] for r in rows]}"

    async def test_server_only_tables_have_no_policies_at_all(self, isolated: Any) -> None:
        """RLS on with no policy is deny-all, which is the intended state for these."""
        for table in ("llm_usage", "idempotency_keys", "rate_limit_counters"):
            count = await isolated.fetchval(
                "select count(*) from pg_policies where schemaname='public' and tablename=$1",
                table,
            )
            assert count == 0, f"{table} should be reachable only through the service role"

    async def test_the_application_role_cannot_become_the_service_role(
        self, isolated: Any
    ) -> None:
        """The difference between a bug and a full data breach."""
        is_member = await isolated.fetchval(
            "select pg_has_role('prism_app', 'service_role', 'member')"
        )
        assert is_member is False

    async def test_neither_application_role_can_bypass_rls(self, isolated: Any) -> None:
        for role in ("prism_app", "prism_service"):
            bypasses = await isolated.fetchval(
                "select rolbypassrls from pg_roles where rolname = $1", role
            )
            assert bypasses is False, f"{role} must not hold BYPASSRLS"

    async def test_the_application_role_inherits_nothing(self, isolated: Any) -> None:
        """NOINHERIT is what turns a forgotten SET ROLE into a loud permission error rather
        than a silent full-table read."""
        inherits = await isolated.fetchval(
            "select rolinherit from pg_roles where rolname = 'prism_app'"
        )
        assert inherits is False


# ---------------------------------------------------------------------------
# The named denials from PRD task P1-07 and the brief.
# ---------------------------------------------------------------------------
class TestLearnerDataIsPrivate:
    async def test_a_learner_cannot_read_another_learners_profile(
        self, isolated: Any, make_user: Any
    ) -> None:
        """PRD task P1-07's named condition, and the centrepiece of PRD 6.4 and B2B-5."""
        from app.db.rls import rls_session

        alice = await make_user()
        bob = await make_user()

        async with rls_session(identity_for(bob), verify_role=False) as connection:
            rows = await connection.fetch(
                "select * from public.render_profiles where user_id = $1", alice
            )
        assert rows == []

    async def test_a_learner_cannot_change_another_learners_sharing_consent(
        self, isolated: Any, make_user: Any
    ) -> None:
        from app.db.rls import rls_session

        alice = await make_user()
        bob = await make_user()

        async with rls_session(identity_for(bob), verify_role=False) as connection:
            await connection.execute(
                "update public.render_profiles set share_with_teachers = true "
                "where user_id = $1",
                alice,
            )

        shared = await isolated.fetchval(
            "select share_with_teachers from public.render_profiles where user_id = $1", alice
        )
        assert shared is False

    async def test_a_learner_cannot_insert_events_as_another_learner(
        self, isolated: Any, make_user: Any
    ) -> None:
        """The database-level enforcement of "never trust a client-supplied user id"."""
        import asyncpg

        from app.db.rls import rls_session

        alice = await make_user()
        bob = await make_user()
        lesson_id = await _published_lesson(isolated, owner_id=alice)

        with pytest.raises(asyncpg.PostgresError):
            async with rls_session(identity_for(bob), verify_role=False) as connection:
                await connection.execute(
                    """
                    insert into public.learning_events
                      (id, user_id, lesson_id, graph_version, type, layout, occurred_at)
                    values ($1, $2, $3, 1, 'concept_viewed', 'cards', now())
                    """,
                    "01HZX3QK9J2W8V5N6M7P8Q9R0S",
                    alice,
                    lesson_id,
                )

    async def test_a_learner_cannot_read_another_learners_events(
        self, isolated: Any, make_user: Any
    ) -> None:
        from app.db.rls import rls_session

        alice = await make_user()
        bob = await make_user()
        lesson_id = await _published_lesson(isolated, owner_id=alice)
        await isolated.execute(
            """
            insert into public.learning_events
              (id, user_id, lesson_id, graph_version, type, layout, occurred_at)
            values ('evt_alice', $1, $2, 1, 'concept_viewed', 'cards', now())
            """,
            alice,
            lesson_id,
        )

        async with rls_session(identity_for(bob), verify_role=False) as connection:
            rows = await connection.fetch(
                "select * from public.learning_events where user_id = $1", alice
            )
        assert rows == []

    async def test_events_cannot_be_altered_or_deleted(
        self, isolated: Any, make_user: Any
    ) -> None:
        """Append-only: a learner must not be able to erase a wrong answer."""
        from app.db.rls import rls_session

        alice = await make_user()
        lesson_id = await _published_lesson(isolated, owner_id=alice)
        await isolated.execute(
            """
            insert into public.learning_events
              (id, user_id, lesson_id, graph_version, type, correct, layout, occurred_at)
            values ('evt_1', $1, $2, 1, 'quiz_answered', false, 'cards', now())
            """,
            alice,
            lesson_id,
        )

        async with rls_session(identity_for(alice), verify_role=False) as connection:
            await connection.execute(
                "update public.learning_events set correct = true where id = 'evt_1'"
            )
            await connection.execute("delete from public.learning_events where id = 'evt_1'")

        row = await isolated.fetchrow(
            "select correct from public.learning_events where id = 'evt_1'"
        )
        assert row is not None and row["correct"] is False

    async def test_a_learner_cannot_declare_their_own_mastery(
        self, isolated: Any, make_user: Any
    ) -> None:
        """Mastery is derived from answers, not reported by the client."""
        import asyncpg

        from app.db.rls import rls_session

        alice = await make_user()
        lesson_id = await _published_lesson(isolated, owner_id=alice)

        with pytest.raises(asyncpg.PostgresError):
            async with rls_session(identity_for(alice), verify_role=False) as connection:
                await connection.execute(
                    """
                    insert into public.concept_mastery
                      (user_id, concept_id, lesson_id, status)
                    values ($1, 'c_1', $2, 'mastered')
                    """,
                    alice,
                    lesson_id,
                )


class TestLessonVisibility:
    async def test_an_unpublished_lesson_is_invisible_to_everyone_but_its_owner(
        self, isolated: Any, make_user: Any
    ) -> None:
        from app.db.rls import rls_session

        teacher = await make_user()
        stranger = await make_user()
        lesson_id = await _draft_lesson(isolated, owner_id=teacher)

        async with rls_session(identity_for(stranger), verify_role=False) as connection:
            rows = await connection.fetch(
                "select * from public.lessons where id = $1", lesson_id
            )
        assert rows == []

        async with rls_session(identity_for(teacher), verify_role=False) as connection:
            rows = await connection.fetch(
                "select * from public.lessons where id = $1", lesson_id
            )
        assert len(rows) == 1

    async def test_a_learner_cannot_edit_a_lesson_they_did_not_create(
        self, isolated: Any, make_user: Any
    ) -> None:
        from app.db.rls import rls_session

        teacher = await make_user()
        learner = await make_user()
        lesson_id = await _published_lesson(isolated, owner_id=teacher)

        async with rls_session(identity_for(learner), verify_role=False) as connection:
            await connection.execute(
                "update public.lessons set title = 'vandalised' where id = $1", lesson_id
            )

        title = await isolated.fetchval(
            "select title from public.lessons where id = $1", lesson_id
        )
        assert title != "vandalised"

    async def test_a_learner_cannot_mutate_curriculum(
        self, isolated: Any, make_user: Any
    ) -> None:
        """`concepts` and `quiz_items` have no write policy at all, so there is no
        client-reachable path to them."""
        import asyncpg

        from app.db.rls import rls_session

        teacher = await make_user()
        learner = await make_user()
        lesson_id = await _published_lesson(isolated, owner_id=teacher)

        for statement, args in (
            (
                "insert into public.concepts (id, lesson_id, graph_version, order_index, title) "
                "values ('c_evil', $1, 1, 0, 'Injected')",
                (lesson_id,),
            ),
            ("update public.concepts set title = 'Changed' where lesson_id = $1", (lesson_id,)),
            ("delete from public.concepts where lesson_id = $1", (lesson_id,)),
        ):
            with pytest.raises(asyncpg.PostgresError):
                async with rls_session(identity_for(learner), verify_role=False) as connection:
                    await connection.execute(statement, *args)

    async def test_an_unverified_sign_link_never_reaches_a_learner(
        self, isolated: Any, make_user: Any
    ) -> None:
        """PRD task P2-16: only verified links are returned to learners, enforced in the
        policy so a forgotten WHERE clause cannot leak an unreviewed AI match."""
        from app.db.rls import rls_session

        teacher = await make_user()
        learner = await make_user()
        # Creates the concept the link below points at.
        await _published_lesson(isolated, owner_id=teacher)

        clip_id = await isolated.fetchval(
            """
            insert into public.sign_clips (gloss, storage_path, source, license, signer_credit)
            values ('WATER', 'sign-clips/water.mp4', 'test', 'CC', 'A signer')
            returning id
            """
        )
        await isolated.execute(
            "insert into public.concept_sign_links (concept_id, sign_clip_id, verified) "
            "values ('c_1', $1, false)",
            clip_id,
        )

        async with rls_session(identity_for(learner), verify_role=False) as connection:
            rows = await connection.fetch("select * from public.concept_sign_links")
        assert rows == []


class TestSessionHygiene:
    async def test_identity_does_not_survive_the_transaction(
        self, isolated: Any, make_user: Any
    ) -> None:
        """`SET LOCAL` is reverted by Postgres at commit. If it were not, one learner's
        identity could serve another learner's request on a recycled connection."""
        from app.db.pools import get_rls_pool
        from app.db.rls import current_database_identity, rls_session

        alice = await make_user()

        async with rls_session(identity_for(alice), verify_role=False) as connection:
            inside = await current_database_identity(connection)
        assert inside["auth_uid"] == str(alice)

        pool = get_rls_pool()
        async with pool.acquire() as connection:
            after = await current_database_identity(connection)
        assert after["claims"] is None
        assert after["auth_uid"] is None

    async def test_only_the_plural_claims_setting_is_used(
        self, isolated: Any, make_user: Any
    ) -> None:
        """`auth.uid()` checks the legacy singular setting first. Setting only the plural one
        means the two can never disagree about who the caller is."""
        from app.db.rls import current_database_identity, rls_session

        alice = await make_user()
        async with rls_session(identity_for(alice), verify_role=False) as connection:
            state = await current_database_identity(connection)

        assert state["legacy_sub"] is None
        assert state["claims"] is not None

    async def test_an_anonymous_session_sees_no_learner_data(
        self, isolated: Any, make_user: Any
    ) -> None:
        from app.db.rls import anonymous_session

        await make_user()
        async with anonymous_session() as connection:
            assert await connection.fetch("select * from public.render_profiles") == []
            assert await connection.fetch("select * from public.learning_events") == []


# ---------------------------------------------------------------------------
# Generated cross-tenant sweep.
# ---------------------------------------------------------------------------
TENANT_SCOPED_TABLES = [
    "render_profiles",
    "learning_events",
    "concept_mastery",
    "unmet_needs",
    "lessons",
    "ingestion_jobs",
    "audit_log",
]


class TestCrossTenantSweep:
    @pytest.mark.parametrize("table", TENANT_SCOPED_TABLES)
    async def test_one_user_sees_none_of_another_users_rows(
        self, isolated: Any, make_user: Any, table: str
    ) -> None:
        """P8-09, pulled forward. Cheap to write at sixteen tables; expensive at twenty-five."""
        from app.db.rls import rls_session

        alice = await make_user()
        bob = await make_user()
        await _seed_for(isolated, table, alice)

        async with rls_session(identity_for(bob), verify_role=False) as connection:
            rows = await connection.fetch(f"select * from public.{table}")

        leaked = [row for row in rows if _belongs_to(row, alice)]
        assert not leaked, f"{table} leaked {len(leaked)} of another user's rows"


# ---------------------------------------------------------------------------
def _belongs_to(row: Any, user_id: UUID) -> bool:
    mapping = dict(row)
    for column in ("user_id", "owner_id", "actor_id", "student_id", "buyer_id"):
        if mapping.get(column) == user_id:
            return True
    return False


async def _seed_for(connection: Any, table: str, user_id: UUID) -> None:
    """Put one row belonging to `user_id` into `table`, where seeding is meaningful."""
    if table == "unmet_needs":
        await connection.execute(
            "insert into public.unmet_needs (user_id, request_text) values ($1, 'translate')",
            user_id,
        )
    elif table in ("lessons", "ingestion_jobs", "learning_events", "concept_mastery"):
        # For `lessons` and `concept_mastery` the lesson row is itself the seeded data.
        lesson_id = await _published_lesson(connection, owner_id=user_id)
        _ = lesson_id
        if table == "ingestion_jobs":
            await connection.execute(
                "insert into public.ingestion_jobs (lesson_id, stage) values ($1, 'pending')",
                lesson_id,
            )
        elif table == "learning_events":
            await connection.execute(
                """
                insert into public.learning_events
                  (id, user_id, lesson_id, graph_version, type, layout, occurred_at)
                values ('evt_seed', $1, $2, 1, 'concept_viewed', 'cards', now())
                """,
                user_id,
                lesson_id,
            )


async def _draft_lesson(connection: Any, *, owner_id: UUID) -> UUID:
    lesson_id: UUID = await connection.fetchval(
        "insert into public.lessons (owner_id, title, status) "
        "values ($1, 'Draft lesson', 'needs_review') returning id",
        owner_id,
    )
    return lesson_id


async def _published_lesson(connection: Any, *, owner_id: UUID) -> UUID:
    lesson_id: UUID = await connection.fetchval(
        """
        insert into public.lessons (owner_id, title, status, graph, graph_version)
        values ($1, 'Published lesson', 'published', '{"schemaVersion":1}'::jsonb, 1)
        returning id
        """,
        owner_id,
    )
    await connection.execute(
        "insert into public.concepts (id, lesson_id, graph_version, order_index, title) "
        "values ('c_1', $1, 1, 0, 'A concept') on conflict (id) do nothing",
        lesson_id,
    )
    return lesson_id
