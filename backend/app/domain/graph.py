"""Pure graph algorithms over concept structures.

Deliberately free of Pydantic, I/O and PRD types: these operate on primitive mappings so the
same functions serve schema validation, the ingestion validate stage, and the publish path
without any of them importing each other.

PRD task P2-05 requires that prerequisite cycles be "enforced in code, not only by the prompt".
That is what this module exists for.
"""

from __future__ import annotations

from collections import defaultdict, deque
from collections.abc import Iterable, Mapping, Sequence

# A concept id mapped to the concept ids it depends on (its prerequisites).
PrereqMap = Mapping[str, Sequence[str]]


def find_duplicates(ids: Iterable[str]) -> list[str]:
    """Ids appearing more than once, in first-seen order."""
    seen: set[str] = set()
    duplicated: dict[str, None] = {}
    for value in ids:
        if value in seen:
            duplicated[value] = None
        seen.add(value)
    return list(duplicated)


def find_dangling(references: Iterable[str], known: Iterable[str]) -> list[str]:
    """References that point at nothing, de-duplicated and order-preserving."""
    known_set = set(known)
    missing: dict[str, None] = {}
    for ref in references:
        if ref not in known_set:
            missing[ref] = None
    return list(missing)


def has_prerequisite_cycle(prerequisites: PrereqMap) -> bool:
    """True when the prerequisite graph cannot be linearised.

    Kahn's algorithm, O(V+E). Edges outside the key set are ignored; dangling references are a
    separate finding and must not be mistaken for a cycle.
    """
    return bool(_kahn_residual(prerequisites))


def find_prerequisite_cycles(prerequisites: PrereqMap) -> list[list[str]]:
    """The cycles themselves, so a teacher can be shown what to break.

    Kahn detects; Tarjan explains. Running Tarjan only over Kahn's residual keeps the more
    expensive pass on the error path, where it belongs. Each returned list is a strongly
    connected component of two or more concepts, plus any self-dependency.
    """
    residual = _kahn_residual(prerequisites)
    if not residual:
        return []

    components = [
        sorted(component)
        for component in _strongly_connected(residual, prerequisites)
        if len(component) > 1
    ]
    # A concept listing itself as its own prerequisite is a one-node cycle that SCC size
    # filtering would otherwise drop.
    components.extend(
        [node] for node in sorted(residual) if node in set(prerequisites.get(node, ()))
    )
    return components


def _kahn_residual(prerequisites: PrereqMap) -> set[str]:
    """Nodes that never reach in-degree zero: exactly the nodes involved in or downstream
    of a cycle. Empty when the graph is acyclic."""
    nodes = set(prerequisites)
    indegree: dict[str, int] = {}
    successors: dict[str, list[str]] = defaultdict(list)

    for node, prereqs in prerequisites.items():
        internal = [p for p in prereqs if p in nodes]
        indegree[node] = len(internal)
        for prereq in internal:
            successors[prereq].append(node)

    queue = deque(node for node, degree in indegree.items() if degree == 0)
    settled = 0
    while queue:
        node = queue.popleft()
        settled += 1
        for dependant in successors[node]:
            indegree[dependant] -= 1
            if indegree[dependant] == 0:
                queue.append(dependant)

    if settled == len(nodes):
        return set()
    return {node for node, degree in indegree.items() if degree > 0}


def _strongly_connected(nodes: set[str], prerequisites: PrereqMap) -> list[list[str]]:
    """Tarjan's SCC, iterative.

    Iterative rather than recursive on purpose: a long prerequisite chain in a large lesson
    would otherwise hit CPython's recursion limit, and it would do so on the error path, which
    is the worst possible place for a second, unrelated failure.
    """
    index_of: dict[str, int] = {}
    lowlink: dict[str, int] = {}
    on_stack: set[str] = set()
    stack: list[str] = []
    components: list[list[str]] = []
    counter = 0

    def neighbours(node: str) -> list[str]:
        return [p for p in prerequisites.get(node, ()) if p in nodes]

    for root in sorted(nodes):
        if root in index_of:
            continue
        # Each frame is (node, iterator position over its neighbours).
        work: list[tuple[str, int]] = [(root, 0)]
        index_of[root] = lowlink[root] = counter
        counter += 1
        stack.append(root)
        on_stack.add(root)

        while work:
            node, position = work[-1]
            adjacent = neighbours(node)
            if position < len(adjacent):
                work[-1] = (node, position + 1)
                child = adjacent[position]
                if child not in index_of:
                    index_of[child] = lowlink[child] = counter
                    counter += 1
                    stack.append(child)
                    on_stack.add(child)
                    work.append((child, 0))
                elif child in on_stack:
                    lowlink[node] = min(lowlink[node], index_of[child])
                continue

            work.pop()
            if work:
                parent = work[-1][0]
                lowlink[parent] = min(lowlink[parent], lowlink[node])
            if lowlink[node] == index_of[node]:
                component: list[str] = []
                while True:
                    member = stack.pop()
                    on_stack.discard(member)
                    component.append(member)
                    if member == node:
                        break
                components.append(component)

    return components


def topological_order(prerequisites: PrereqMap) -> list[str] | None:
    """A prerequisite-respecting order, or None when the graph has a cycle.

    Ties break on the id so the result is deterministic across runs, which matters for the
    golden-file ingestion tests.
    """
    nodes = set(prerequisites)
    indegree: dict[str, int] = {}
    successors: dict[str, list[str]] = defaultdict(list)
    for node, prereqs in prerequisites.items():
        internal = [p for p in prereqs if p in nodes]
        indegree[node] = len(internal)
        for prereq in internal:
            successors[prereq].append(node)

    ready = sorted(node for node, degree in indegree.items() if degree == 0)
    ordered: list[str] = []
    while ready:
        node = ready.pop(0)
        ordered.append(node)
        for dependant in sorted(successors[node]):
            indegree[dependant] -= 1
            if indegree[dependant] == 0:
                ready.append(dependant)
                ready.sort()

    return ordered if len(ordered) == len(nodes) else None
