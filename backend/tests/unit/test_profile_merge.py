"""Profile patching (PRD task P3-01, CE-4, brief section 28).

The invariant under test throughout: an invalid patch leaves the existing profile untouched.
"""

from __future__ import annotations

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from app.domain.profiles.merge import ProfilePatchError, deep_merge_profile, normalize_keys
from app.domain.profiles.presets import build_preset
from app.schemas.render_profile import RenderProfile


class TestMerging:
    def test_a_nested_patch_touches_only_what_it_names(self) -> None:
        base = RenderProfile()
        merged = deep_merge_profile(base, {"typography": {"line_height": 2.0}})

        assert merged.typography.line_height == 2.0
        # Siblings inside the same group survive.
        assert merged.typography.font == base.typography.font
        assert merged.typography.max_line_length == base.typography.max_line_length
        # Other groups are untouched.
        assert merged.quiz == base.quiz
        assert merged.audio == base.audio

    def test_camel_case_patches_are_accepted(self) -> None:
        """Patches arrive from the browser and from LLM output in camelCase."""
        merged = deep_merge_profile(RenderProfile(), {"content": {"readingLevel": "plain"}})
        assert merged.content.reading_level == "plain"

    def test_mixed_spellings_of_one_setting_do_not_collide(self) -> None:
        merged = deep_merge_profile(
            RenderProfile(),
            {"content": {"readingLevel": "plain"}, "quiz": {"items_per_check": 3}},
        )
        assert merged.content.reading_level == "plain"
        assert merged.quiz.items_per_check == 3

    def test_an_empty_patch_is_a_no_op(self) -> None:
        base = build_preset("cognitive_ease")
        assert deep_merge_profile(base, {}) == base

    def test_lists_replace_rather_than_append(self) -> None:
        """"Use these examples" means instead of, not as well as."""
        merged = deep_merge_profile(RenderProfile(), {"layout": "cards"})
        assert merged.layout == "cards"

    def test_the_base_profile_is_never_mutated(self) -> None:
        base = RenderProfile()
        original = base.model_dump(mode="json")
        deep_merge_profile(base, {"typography": {"line_height": 2.4}})
        assert base.model_dump(mode="json") == original

    def test_schema_version_cannot_be_patched(self) -> None:
        """The schema version is the contract's identity, not a learner preference."""
        merged = deep_merge_profile(RenderProfile(), {"schemaVersion": 99})
        assert merged.schema_version == 1


class TestRejection:
    def test_an_unknown_setting_is_rejected(self) -> None:
        with pytest.raises(ProfilePatchError):
            deep_merge_profile(RenderProfile(), {"typography": {"fontWeight": 700}})

    def test_an_out_of_range_value_is_rejected(self) -> None:
        with pytest.raises(ProfilePatchError) as caught:
            deep_merge_profile(RenderProfile(), {"quiz": {"cadence": 99}})
        assert any("cadence" in problem for problem in caught.value.problems)

    def test_an_invalid_enum_value_is_rejected(self) -> None:
        with pytest.raises(ProfilePatchError):
            deep_merge_profile(RenderProfile(), {"layout": "holodeck"})

    def test_a_non_object_patch_is_rejected(self) -> None:
        with pytest.raises(ProfilePatchError):
            deep_merge_profile(RenderProfile(), ["layout", "cards"])  # type: ignore[arg-type]

    def test_the_rejection_message_is_safe_to_show_a_learner(self) -> None:
        with pytest.raises(ProfilePatchError) as caught:
            deep_merge_profile(RenderProfile(), {"quiz": {"cadence": 99}})
        assert "left unchanged" in str(caught.value)


class TestTheCentralInvariant:
    @settings(max_examples=100, deadline=None)
    @given(
        st.dictionaries(
            keys=st.sampled_from(["layout", "preset", "typography", "quiz", "nonsense"]),
            values=st.one_of(
                st.sampled_from(["cards", "reader", "holodeck", "", "plain"]),
                st.integers(min_value=-5, max_value=99),
                st.booleans(),
                st.none(),
                st.fixed_dictionaries(
                    {},
                    optional={
                        "font": st.sampled_from(["lexend", "comic", "system"]),
                        "cadence": st.integers(min_value=-2, max_value=20),
                        "bogus": st.just(1),
                    },
                ),
            ),
            max_size=3,
        )
    )
    def test_a_failed_patch_never_changes_the_profile(self, patch: dict[str, object]) -> None:
        """CE-4 and brief 60: profile parse failure must never mutate the existing profile.

        Whatever arbitrary patch arrives, exactly one of two things happens: a fully valid new
        profile is returned, or the original is still exactly as it was. There is no
        half-applied state.
        """
        base = build_preset("hyper_focus")
        snapshot = base.model_dump(mode="json")

        try:
            result = deep_merge_profile(base, patch)
        except ProfilePatchError:
            assert base.model_dump(mode="json") == snapshot
        else:
            assert isinstance(result, RenderProfile)
            RenderProfile.model_validate(result.model_dump(mode="json"))
            assert base.model_dump(mode="json") == snapshot


class TestKeyNormalization:
    def test_camel_keys_become_snake(self) -> None:
        assert normalize_keys({"readingLevel": 1, "maxLineLength": 2}) == {
            "reading_level": 1,
            "max_line_length": 2,
        }

    def test_normalization_is_recursive(self) -> None:
        assert normalize_keys({"outerKey": {"innerKey": [{"deepKey": 1}]}}) == {
            "outer_key": {"inner_key": [{"deep_key": 1}]}
        }

    def test_snake_keys_are_left_alone(self) -> None:
        assert normalize_keys({"reading_level": 1}) == {"reading_level": 1}
