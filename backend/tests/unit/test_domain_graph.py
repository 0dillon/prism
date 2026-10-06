"""Prerequisite graph algorithms (PRD task P2-05)."""

from __future__ import annotations

from hypothesis import given
from hypothesis import strategies as st

from app.domain.graph import (
    find_dangling,
    find_duplicates,
    find_prerequisite_cycles,
    has_prerequisite_cycle,
    topological_order,
)


class TestDuplicatesAndDangling:
    def test_duplicates_are_reported_once_in_first_seen_order(self) -> None:
        assert find_duplicates(["a", "b", "a", "c", "b", "a"]) == ["a", "b"]
        assert find_duplicates(["a", "b", "c"]) == []

    def test_dangling_references_are_reported_once(self) -> None:
        assert find_dangling(["a", "x", "y", "x"], ["a", "b"]) == ["x", "y"]
        assert find_dangling(["a"], ["a", "b"]) == []


class TestCycleDetection:
    def test_an_acyclic_graph_has_no_cycles(self) -> None:
        graph = {"c": ["b"], "b": ["a"], "a": []}
        assert has_prerequisite_cycle(graph) is False
        assert find_prerequisite_cycles(graph) == []

    def test_a_two_node_cycle_is_found(self) -> None:
        graph = {"a": ["b"], "b": ["a"]}
        assert has_prerequisite_cycle(graph) is True
        assert find_prerequisite_cycles(graph) == [["a", "b"]]

    def test_a_longer_cycle_is_reported_in_full(self) -> None:
        """The teacher needs to see the actual loop in order to break it."""
        graph = {"a": ["c"], "b": ["a"], "c": ["b"]}
        assert find_prerequisite_cycles(graph) == [["a", "b", "c"]]

    def test_a_self_dependency_is_a_cycle(self) -> None:
        graph = {"a": ["a"], "b": []}
        assert has_prerequisite_cycle(graph) is True
        assert ["a"] in find_prerequisite_cycles(graph)

    def test_two_separate_cycles_are_both_reported(self) -> None:
        graph = {"a": ["b"], "b": ["a"], "x": ["y"], "y": ["x"], "ok": []}
        assert sorted(find_prerequisite_cycles(graph)) == [["a", "b"], ["x", "y"]]

    def test_dangling_references_are_not_mistaken_for_cycles(self) -> None:
        """A missing prerequisite is a separate, separately reported problem."""
        graph = {"a": ["ghost"], "b": ["a"]}
        assert has_prerequisite_cycle(graph) is False

    def test_a_deep_chain_does_not_exhaust_the_stack(self) -> None:
        """Iterative, not recursive: a long chain must not raise RecursionError.

        It would do so on the error path, which is the worst place for a second failure.
        """
        depth = 5_000
        chain = {f"c{i}": ([f"c{i - 1}"] if i else []) for i in range(depth)}
        assert has_prerequisite_cycle(chain) is False

        chain["c0"] = [f"c{depth - 1}"]  # close the loop
        assert has_prerequisite_cycle(chain) is True
        assert len(find_prerequisite_cycles(chain)[0]) == depth


class TestTopologicalOrder:
    def test_order_respects_prerequisites(self) -> None:
        order = topological_order({"c": ["b"], "b": ["a"], "a": []})
        assert order == ["a", "b", "c"]

    def test_order_is_deterministic_across_runs(self) -> None:
        graph = {"a": [], "b": [], "c": [], "d": ["a"]}
        assert topological_order(graph) == topological_order(graph)

    def test_a_cyclic_graph_has_no_order(self) -> None:
        assert topological_order({"a": ["b"], "b": ["a"]}) is None


class TestInvariants:
    @given(
        st.dictionaries(
            keys=st.text(alphabet="abcdef", min_size=1, max_size=2),
            values=st.lists(st.text(alphabet="abcdef", min_size=1, max_size=2), max_size=4),
            max_size=8,
        )
    )
    def test_an_order_exists_exactly_when_there_is_no_cycle(
        self, graph: dict[str, list[str]]
    ) -> None:
        """The two algorithms must never disagree."""
        assert (topological_order(graph) is None) == has_prerequisite_cycle(graph)

    @given(
        st.dictionaries(
            keys=st.text(alphabet="abcdef", min_size=1, max_size=2),
            values=st.lists(st.text(alphabet="abcdef", min_size=1, max_size=2), max_size=4),
            max_size=8,
        )
    )
    def test_a_valid_order_places_every_prerequisite_first(
        self, graph: dict[str, list[str]]
    ) -> None:
        order = topological_order(graph)
        if order is None:
            return
        position = {node: index for index, node in enumerate(order)}
        for node, prereqs in graph.items():
            for prereq in prereqs:
                if prereq in position:
                    assert position[prereq] < position[node]
