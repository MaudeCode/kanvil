import { useEffect, type ReactNode } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, CornerLeftUp } from "lucide-react";
import {
  ApiError,
  closedStates,
  relationReference,
  type PublicProject as Project,
  type PublicTicket,
} from "@kanvil/contracts";
import { api } from "./data.tsx";
import {
  Brand,
  Button,
  DueDate,
  EmptyState,
  ErrorNotice,
  Loading,
  Markdown,
  PageHeader,
  RelativeTime,
  SectionHeading,
  TicketIndicator,
  ticketTitleClass,
} from "./ui.tsx";
import { ProjectIcon } from "./components/project-icon.tsx";
import { ProjectLabelProvider } from "./components/project-label-provider.tsx";
import { PropertyRow, PropertyValue } from "./components/ticket-property.tsx";
import { TicketTag } from "./components/ticket-tags.tsx";
import { TicketLink } from "./components/ticket-link.tsx";
import { dayFormat } from "./components/date-picker.tsx";
import { Badge } from "@/components/ui/badge";
import { Item, ItemContent, ItemGroup } from "@/components/ui/item";

// Read-only pages for a project its administrators shared by link. They read the public
// projection only, so they work signed out and show no member, coordination, or write controls.
const pageSize = 100;
const unavailable = (error: unknown) => error instanceof ApiError && error.status === 404;
// A revoked or unknown link answers 404 at once; only transient failures are worth retrying.
const retry = (failures: number, error: unknown) =>
  failures < 2 && !(error instanceof ApiError && error.status < 500);
const stateOf = (project: Project, ticket: Pick<PublicTicket, "status" | "stateId">) =>
  project.states.find((state) => state.id === ticket.stateId) ??
  project.states.find((state) => state.category === ticket.status);
function Status({
  project,
  ticket,
  iconOnly = false,
}: {
  project: Project;
  ticket: Pick<PublicTicket, "status" | "stateId">;
  iconOnly?: boolean;
}) {
  const state = stateOf(project, ticket);
  return (
    <TicketIndicator
      property="status"
      value={ticket.status}
      label={state?.name}
      color={state?.color}
      iconOnly={iconOnly}
    />
  );
}
function PublicFrame({ project, children }: { project?: Project; children: ReactNode }) {
  useEffect(() => {
    if (project) document.title = `${project.name} · Kanvil`;
  }, [project]);
  return (
    <div className="min-h-svh bg-background">
      <header className="flex items-center justify-between gap-3 border-b px-4 py-2.5 md:px-6">
        <span className="flex items-center gap-2">
          <Brand />
        </span>
        <Button variant="ghost" size="sm" render={<a href="/" />}>
          Open Kanvil
        </Button>
      </header>
      <main id="main" className="@container mx-auto w-full max-w-5xl px-4 py-6 md:px-6">
        <ProjectLabelProvider projectId={undefined} labels={project?.labels ?? []}>
          {children}
        </ProjectLabelProvider>
      </main>
    </div>
  );
}
// A shared project that was never shared, was revoked, or does not exist reads the same.
function Unavailable() {
  return (
    <PublicFrame>
      <EmptyState title="This project is not shared">
        <p className="m-0 text-sm text-muted-foreground">
          The link was turned off or never existed. Members can sign in to read it.
        </p>
      </EmptyState>
    </PublicFrame>
  );
}
function Failed({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <PublicFrame>
      <ErrorNotice error={error} />
      <Button onClick={onRetry}>Retry</Button>
    </PublicFrame>
  );
}
// Every published ticket, fetched in bounded batches.
function usePublicTickets(projectId: string) {
  const first = useQuery({
    ...api.publicQuery("list_public_tickets", { projectId, limit: pageSize, offset: 0 }),
    retry,
  });
  const rest = useQueries({
    queries: Array.from(
      { length: Math.max(0, Math.ceil((first.data?.total ?? 0) / pageSize) - 1) },
      (_, page) => ({
        ...api.publicQuery("list_public_tickets", {
          projectId,
          limit: pageSize,
          offset: (page + 1) * pageSize,
        }),
        retry,
      }),
    ),
  });
  const pages = [first, ...rest];
  return {
    tickets: pages.flatMap((page) => page.data?.items ?? []),
    pending: pages.some((page) => page.isPending),
    error: pages.find((page) => page.error)?.error,
    refetch: () => {
      for (const page of pages) void page.refetch();
    },
  };
}
export function PublicProject({ projectId }: { projectId: string }) {
  const project = useQuery({ ...api.publicQuery("get_public_project", { projectId }), retry }),
    list = usePublicTickets(projectId);
  // A refetch that finds sharing revoked hides content already on screen.
  if (unavailable(project.error) || unavailable(list.error)) return <Unavailable />;
  if (project.error || list.error)
    return (
      <Failed
        error={project.error ?? list.error}
        onRetry={() => {
          void project.refetch();
          list.refetch();
        }}
      />
    );
  if (!project.data || list.pending)
    return (
      <PublicFrame>
        <Loading />
      </PublicFrame>
    );
  const shared = project.data,
    sections = shared.states
      .map((state) => ({
        state,
        tickets: list.tickets.filter((ticket) => stateOf(shared, ticket)?.id === state.id),
      }))
      .filter((section) => section.tickets.length);
  return (
    <PublicFrame project={shared}>
      <div className="animate-in fade-in-0 duration-200">
        <PageHeader
          title={
            <div className="flex min-w-0 items-center gap-3">
              <ProjectIcon project={{ ...shared, image: null }} />
              <h1 className="m-0 text-lg wrap-anywhere">{shared.name}</h1>
              <Badge variant="secondary" className="font-mono text-[10px] font-normal">
                {shared.key}
              </Badge>
            </div>
          }
        />
        {shared.description && (
          <div className="mb-6 max-w-3xl text-sm">
            <Markdown>{shared.description}</Markdown>
          </div>
        )}
        {sections.length ? (
          sections.map(({ state, tickets }) => (
            <section key={state.id} aria-label={state.name} className="mb-6">
              <h2 className="m-0 flex items-center gap-2 border-b py-1.5">
                <TicketIndicator
                  property="status"
                  value={state.category}
                  label={state.name}
                  color={state.color}
                />
                <span className="text-xs tabular-nums text-muted-foreground">{tickets.length}</span>
              </h2>
              <ul className="m-0 list-none p-0">
                {tickets.map((ticket) => (
                  <li key={ticket.id} className="ticket-row border-b">
                    <Link
                      to="/public/projects/$projectId/tickets/$ticketId"
                      params={{ projectId, ticketId: ticket.id }}
                      className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-1 px-1 py-2.5 text-foreground transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                    >
                      <TicketIndicator property="priority" value={ticket.priority} iconOnly />
                      <span className="pt-0.5 font-mono text-[11px] text-muted-foreground">
                        {ticket.key}
                      </span>
                      <span className="min-w-0 flex-1 basis-60 pt-px text-sm wrap-anywhere">
                        {ticket.title}
                      </span>
                      {ticket.labels.length > 0 && (
                        <span className="flex flex-wrap gap-1">
                          {ticket.labels.map((label) => (
                            <TicketTag key={label} tag={label} />
                          ))}
                        </span>
                      )}
                      <DueDate
                        value={ticket.dueAt}
                        open={!closedStates.some((closed) => closed === ticket.status)}
                        className="pt-0.5 text-xs"
                      />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))
        ) : (
          <EmptyState title="No tickets" />
        )}
      </div>
    </PublicFrame>
  );
}
const day = (value: string | null) => (value ? dayFormat.format(new Date(value)) : "None");
export function PublicTicket({ projectId, ticketId }: { projectId: string; ticketId: string }) {
  const project = useQuery({ ...api.publicQuery("get_public_project", { projectId }), retry }),
    result = useQuery({ ...api.publicQuery("get_public_ticket", { projectId, ticketId }), retry });
  if (unavailable(project.error)) return <Unavailable />;
  if (unavailable(result.error))
    return (
      <PublicFrame {...(project.data ? { project: project.data } : {})}>
        <EmptyState title="Ticket unavailable">
          <Button render={<Link to="/public/projects/$projectId" params={{ projectId }} />}>
            Back to tickets
          </Button>
        </EmptyState>
      </PublicFrame>
    );
  if (project.error || result.error)
    return (
      <Failed
        error={project.error ?? result.error}
        onRetry={() => {
          void project.refetch();
          void result.refetch();
        }}
      />
    );
  if (!project.data || !result.data)
    return (
      <PublicFrame>
        <Loading />
      </PublicFrame>
    );
  const shared = project.data,
    { ticket, parent, children, relations } = result.data;
  const reference = (target: { id: string; key: string; title: string }) => (
    <TicketLink projectId={projectId} ticketId={target.id} ticket={target} shared />
  );
  return (
    <PublicFrame project={shared}>
      <article className="grid w-full grid-cols-[minmax(0,1fr)_280px] gap-x-10 animate-in fade-in-0 duration-200 @max-[850px]:flex @max-[850px]:flex-col [&_section]:border-t [&_section]:py-5">
        <div className="min-w-0">
          <PageHeader
            title={
              <Button
                variant="ghost"
                size="sm"
                className="-ml-2 text-muted-foreground"
                render={<Link to="/public/projects/$projectId" params={{ projectId }} />}
              >
                <ArrowLeft />
                {shared.name}
              </Button>
            }
          />
          <header>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
              <span className="font-mono">{ticket.key}</span>
              <Status project={shared} ticket={ticket} />
            </div>
            <h1 className={ticketTitleClass}>{ticket.title}</h1>
          </header>
          <div className="min-w-0 [&>section:first-child]:border-0 [&>section:first-child]:pt-0">
            <section>
              <h2>Description</h2>
              <Markdown>{ticket.description || "_No description_"}</Markdown>
            </section>
            <section>
              <h2>Acceptance criteria</h2>
              <Markdown>{ticket.acceptanceCriteria || "_No acceptance criteria_"}</Markdown>
            </section>
          </div>
        </div>
        <aside
          className="min-w-0 border-l pl-5 @max-[850px]:border-l-0 @max-[850px]:pl-0 [&>section:first-child]:border-0 [&>section:first-child]:pt-0 @max-[850px]:[&>section:first-child]:border-t @max-[850px]:[&>section:first-child]:pt-6"
          aria-label="Ticket properties"
        >
          <section
            aria-label="Properties"
            className="space-y-1.5 text-sm [&_[data-slot=badge]]:ml-0"
          >
            <PropertyRow label="Status">
              <Status project={shared} ticket={ticket} />
            </PropertyRow>
            <PropertyRow label="Priority">
              <TicketIndicator property="priority" value={ticket.priority} />
            </PropertyRow>
            <PropertyRow label="Kind">
              <PropertyValue property="kind" value={ticket.kind} projectId={projectId} />
            </PropertyRow>
            <PropertyRow label="Difficulty">
              <PropertyValue
                property="difficulty"
                value={ticket.difficulty}
                projectId={projectId}
              />
            </PropertyRow>
            <PropertyRow label="Start date">
              <span className="text-xs">{day(ticket.startAt)}</span>
            </PropertyRow>
            <PropertyRow label="Due date">
              <span className="text-xs">{day(ticket.dueAt)}</span>
            </PropertyRow>
            <PropertyRow label="Labels">
              <span className="flex flex-wrap gap-1 text-xs">
                {ticket.labels.length
                  ? ticket.labels.map((label) => <TicketTag key={label} tag={label} />)
                  : "None"}
              </span>
            </PropertyRow>
            {ticket.scopes.length > 0 && (
              <PropertyRow label="Scopes">
                <span className="flex flex-wrap gap-1">
                  {ticket.scopes.map((scope) => (
                    <TicketTag key={scope} tag={scope} kind="scope" variant="outline" />
                  ))}
                </span>
              </PropertyRow>
            )}
            <dl className="mt-4 grid grid-cols-[80px_minmax(0,1fr)] gap-x-2 gap-y-1.5 border-t pt-4 text-xs [&_dd]:m-0 [&_dt]:text-muted-foreground">
              <dt>Created</dt>
              <dd>
                <RelativeTime value={ticket.createdAt} />
              </dd>
              <dt>Updated</dt>
              <dd>
                <RelativeTime value={ticket.updatedAt} />
              </dd>
            </dl>
          </section>
          {(parent || children.length > 0 || relations.length > 0) && (
            <section>
              <SectionHeading compact title="Relationships" />
              <ItemGroup className="gap-0">
                {parent && (
                  <Item size="xs" className="px-0">
                    <CornerLeftUp
                      className="size-3.5 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <ItemContent className="min-w-0 gap-0">
                      <span className="text-xs text-muted-foreground">Parent</span>
                      {reference(parent)}
                    </ItemContent>
                  </Item>
                )}
                {children.map((child) => (
                  <Item key={child.id} size="xs" className="px-0">
                    <Status project={shared} ticket={child} iconOnly />
                    <ItemContent className="min-w-0 gap-0">
                      <span className="text-xs text-muted-foreground">Child</span>
                      {reference(child)}
                    </ItemContent>
                  </Item>
                ))}
                {relations.map((relation) => {
                  const linked = relationReference({ ...relation, projectId }, ticket.id);
                  return (
                    <Item key={relation.id} size="xs" className="px-0">
                      <ItemContent className="min-w-0 gap-0">
                        <span className="text-xs text-muted-foreground">{linked.label}</span>
                        <TicketLink projectId={projectId} ticketId={linked.id} shared>
                          {linked.title}
                        </TicketLink>
                      </ItemContent>
                    </Item>
                  );
                })}
              </ItemGroup>
            </section>
          )}
        </aside>
      </article>
    </PublicFrame>
  );
}
