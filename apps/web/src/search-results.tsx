import { useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { searchResultTypes } from "@kanvil/contracts";
import { z } from "zod";
import { api, useWorkspace } from "./data.tsx";
import { Button, EmptyState, ErrorNotice, Loading, PageHeader, SearchField } from "./ui.tsx";
import { useShortcut } from "./hooks/use-shortcut.ts";
import { TicketLink } from "./components/ticket-link.tsx";
import { SearchResultContent, searchResultLink } from "./components/search-result.tsx";
import type { resultsSearchSchema } from "./search.ts";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";

type ResultsSearch = z.output<typeof resultsSearchSchema>;
const pageSize = 25;
const rowClass =
  "flex min-w-0 px-2 py-2.5 outline-none transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:bg-muted/60 focus-visible:shadow-[inset_2px_0_0_var(--primary)]";
const tabSchema = z.enum(["all", ...searchResultTypes]);
const tabLabels: Record<z.output<typeof tabSchema>, string> = {
  all: "All",
  project: "Projects",
  ticket: "Tickets",
  comment: "Comments",
  activity: "Activity",
};
// Workspace search across tickets, projects, comments, and activity, with its query in the URL.
export function SearchResults({
  search,
  onSearch,
}: {
  search: ResultsSearch;
  onSearch: (search: ResultsSearch) => void;
}) {
  const workspace = useWorkspace(),
    q = search.q ?? "";
  // The field keeps what was typed, including trailing spaces the URL trims away.
  const [draft, setDraft] = useState(q),
    [synced, setSynced] = useState(q);
  if (q !== synced) {
    setSynced(q);
    setDraft(q);
  }
  const results = useQuery({
    ...api.query("search_workspace", {
      q,
      ...(workspace.active ? { workspaceId: workspace.active.id } : {}),
      ...(search.type ? { type: search.type } : {}),
      limit: pageSize,
      offset: search.offset,
    }),
    enabled: q.length > 0 && !workspace.pending,
    placeholderData: keepPreviousData,
  });
  const list = useRef<HTMLOListElement>(null);
  // J and K walk focus through the results, like the ticket list highlight.
  const step = (delta: number) => {
    const links = [...(list.current?.querySelectorAll<HTMLAnchorElement>("a") ?? [])];
    const current = links.findIndex((link) => link === document.activeElement);
    links[Math.min(links.length - 1, Math.max(0, current < 0 ? 0 : current + delta))]?.focus();
  };
  useShortcut("j", () => step(1));
  useShortcut("k", () => step(-1));
  const data = results.data,
    shown = data?.items.length ?? 0;
  return (
    <div className="animate-in fade-in-0">
      <PageHeader title="Search" />
      <SearchField
        label="Search workspace"
        placeholder="Search tickets, projects, comments, activity…"
        shortcut="/"
        defaultOpen
        wide
        value={draft}
        onChange={(value) => {
          setDraft(value);
          const next = value.trim();
          setSynced(next);
          onSearch({ ...search, q: next || undefined, offset: 0 });
        }}
        className="mb-3"
      />
      {q && (
        <Tabs
          value={search.type ?? "all"}
          onValueChange={(value) => {
            const tab = tabSchema.parse(value);
            onSearch({ ...search, type: tab === "all" ? undefined : tab, offset: 0 });
          }}
          className="mb-2"
        >
          <TabsList variant="line" className="max-w-full justify-start overflow-x-auto">
            {tabSchema.options.map((tab) => {
              const count = !data
                ? undefined
                : tab === "all"
                  ? Object.values(data.counts).reduce((sum, value) => sum + value, 0)
                  : data.counts[tab];
              return (
                <TabsTrigger key={tab} value={tab}>
                  {tabLabels[tab]}
                  {count !== undefined && (
                    <Badge variant="secondary" className="ml-1 tabular-nums">
                      {count}
                    </Badge>
                  )}
                </TabsTrigger>
              );
            })}
          </TabsList>
        </Tabs>
      )}
      {data?.indexing && (
        <p role="status" className="my-2 text-xs text-muted-foreground">
          External search is catching up, so ticket matches come from PostgreSQL.
        </p>
      )}
      <ErrorNotice error={results.error} />
      {!q ? (
        <EmptyState title="Search tickets, projects, comments, and activity" icon={Search} />
      ) : results.isPending ? (
        <Loading />
      ) : data && data.total === 0 ? (
        <EmptyState title={`No results for “${q}”`} icon={Search} />
      ) : (
        data && (
          <>
            <ol
              ref={list}
              aria-label="Search results"
              aria-busy={results.isFetching}
              className="m-0 list-none divide-y border-y p-0"
            >
              {data.items.map((result) => (
                <li key={`${result.type}:${result.id}`}>
                  {result.ticket ? (
                    <TicketLink
                      projectId={result.project.id}
                      ticketId={result.ticket.id}
                      ticket={result.ticket}
                      hash={result.type === "comment" ? `comment-${result.id}` : undefined}
                      className={rowClass}
                    >
                      <SearchResultContent result={result} />
                    </TicketLink>
                  ) : (
                    <Link {...searchResultLink(result)} className={rowClass}>
                      <SearchResultContent result={result} />
                    </Link>
                  )}
                </li>
              ))}
            </ol>
            {data.total > pageSize && (
              <nav
                aria-label="Search pages"
                className="mt-3 flex items-center justify-between gap-3 text-xs text-muted-foreground"
              >
                <span className="tabular-nums">
                  {search.offset + 1}–{search.offset + shown} of {data.total}
                </span>
                <span className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={search.offset === 0}
                    onClick={() =>
                      onSearch({ ...search, offset: Math.max(0, search.offset - pageSize) })
                    }
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    // The API pages through the first thousand results.
                    disabled={
                      search.offset + pageSize >= data.total || search.offset + pageSize > 1000
                    }
                    onClick={() => onSearch({ ...search, offset: search.offset + pageSize })}
                  >
                    Next
                  </Button>
                </span>
              </nav>
            )}
          </>
        )
      )}
    </div>
  );
}
