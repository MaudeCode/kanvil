import { FolderOpen, History, MessageSquare } from "lucide-react";
import { searchResultTypes, type SearchResult } from "@kanvil/contracts";
import { labelTable, t } from "@kanvil/contracts/i18n";
import { ActorName, useProjects } from "../data.tsx";
import { RelativeTime, TicketIndicator } from "../ui.tsx";
import { ProjectIcon } from "./project-icon.tsx";
import { CommandShortcut } from "@/components/ui/command";
import { cn } from "@/lib/utils";

export const searchResultLabels = labelTable(searchResultTypes, (type) =>
  t(`shell.search.type.${type}`),
);
// The anchor of a comment result within its ticket.
export const searchResultAnchor = (result: SearchResult) =>
  result.type === "comment" ? `comment-${result.id}` : undefined;
// Where a result opens: its project, its ticket, or the comment within its ticket.
export function searchResultLink(result: SearchResult) {
  if (!result.ticket)
    return { to: "/projects/$projectId", params: { projectId: result.project.id } } as const;
  const ticket = {
    to: "/projects/$projectId/tickets/$ticketId",
    params: { projectId: result.project.id, ticketId: result.ticket.id },
  } as const;
  const hash = searchResultAnchor(result);
  return hash ? { ...ticket, hash } : ticket;
}
// One presentation for a search result, shared by the command palette (`compact`, inside a
// command item) and the results page.
export function SearchResultContent({
  result,
  compact = false,
}: {
  result: SearchResult;
  compact?: boolean;
}) {
  const projects = useProjects();
  const project = projects.data?.find((item) => item.id === result.project.id);
  const icon =
    result.type === "project" ? (
      project ? (
        <ProjectIcon project={project} className="size-4" />
      ) : (
        <FolderOpen />
      )
    ) : result.type === "ticket" && result.ticket ? (
      <TicketIndicator property="status" value={result.ticket.status} iconOnly />
    ) : result.type === "comment" ? (
      <MessageSquare />
    ) : (
      <History />
    );
  const reference = result.ticket?.key ?? result.project.key;
  if (compact)
    return (
      <>
        <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
          {icon}
        </span>
        <span className="min-w-0 truncate">
          {result.type === "comment" ? result.excerpt || result.title : result.title}
        </span>
        <CommandShortcut className="shrink-0 font-mono whitespace-nowrap">
          {result.type === "comment" ? `${searchResultLabels.comment} · ${reference}` : reference}
        </CommandShortcut>
      </>
    );
  return (
    <span className="flex min-w-0 flex-1 items-start gap-3">
      <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4">
        {icon}
      </span>
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="text-[13px] leading-5 wrap-anywhere text-foreground">{result.title}</span>
        {result.excerpt && (
          <span
            className={cn(
              "text-xs leading-5 wrap-anywhere text-muted-foreground",
              result.type === "comment" && "text-foreground/80",
            )}
          >
            {result.excerpt}
          </span>
        )}
        <span className="text-xs text-muted-foreground">
          {searchResultLabels[result.type]}
          {result.type !== "project" && ` · ${reference}`} · {result.project.name}
          {result.actorId && (
            <>
              {" · "}
              <ActorName projectId={result.project.id} actorId={result.actorId} />
            </>
          )}
        </span>
      </span>
      <RelativeTime
        value={result.at}
        className="shrink-0 text-xs whitespace-nowrap text-muted-foreground"
      />
    </span>
  );
}
