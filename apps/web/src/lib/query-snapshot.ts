import type { UseQueryResult } from "@tanstack/react-query";

type QueryState<T> = Pick<UseQueryResult<T>, "isPending" | "isFetching" | "error" | "refetch">;
// QueriesObserver deep-copies plain combined results, separating them from canonical cache data.
class QuerySnapshot<T> {
  readonly pages: (T | undefined)[];
  readonly states: QueryState<T>[];
  constructor(pages: (T | undefined)[], states: QueryState<T>[]) {
    this.pages = pages;
    this.states = states;
  }
}
// Extends the list's page adapter with reference sharing, never another copy of its ticket graph.
export function createQuerySnapshot<T>() {
  let pages: (T | undefined)[] = [];
  let snapshot: QuerySnapshot<T> | undefined;
  return (queries: UseQueryResult<T>[]) => {
    const next = queries.map(({ data }) => data);
    if (next.length !== pages.length || next.some((page, index) => page !== pages[index]))
      pages = next;
    const states = queries.map(({ isPending, isFetching, error, refetch }) => ({
      isPending,
      isFetching,
      error,
      refetch,
    }));
    const previous = snapshot;
    if (
      previous &&
      previous.pages === pages &&
      previous.states.length === states.length &&
      states.every((state, index) => {
        const before = previous.states[index];
        return (
          before?.isPending === state.isPending &&
          before?.isFetching === state.isFetching &&
          before?.error === state.error &&
          before?.refetch === state.refetch
        );
      })
    )
      return previous;
    snapshot = new QuerySnapshot(pages, states);
    return snapshot;
  };
}
