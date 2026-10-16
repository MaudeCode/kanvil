import { TicketPicker } from "./components/ticket-picker.tsx";
import { TicketLink } from "./components/ticket-link.tsx";
import { Unlink, Plus, GitBranchPlus, CornerLeftUp } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  relationReference,
  relationChoices,
  parseRelationChoice,
  type Ticket,
} from "@kanvil/contracts";
import { api, useOperation, useProjectAccess } from "./data.tsx";
import {
  Button,
  IconButton,
  ErrorNotice,
  Loading,
  Modal,
  Select,
  SelectItem,
  TicketIndicator,
  SectionHeading,
  FormActions,
} from "./ui.tsx";
import { Item, ItemContent, ItemActions, ItemGroup } from "@/components/ui/item";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
const TicketEditor = lazy(() =>
  import("./ticket-editor.tsx").then((module) => ({ default: module.TicketEditor })),
);

export function Relations({ ticket }: { ticket: Ticket }) {
  const access = useProjectAccess(ticket.projectId);
  const relations = useQuery(
    api.query("list_relations", { projectId: ticket.projectId, ticketId: ticket.id }),
  );
  const [open, setOpen] = useState(false),
    [creatingChild, setCreatingChild] = useState(false),
    [target, setTarget] = useState<string | null>(null),
    [offset, setOffset] = useState(0),
    [validationError, setValidationError] = useState<unknown>();
  const parent = useQuery({
    ...api.query("get_ticket", {
      projectId: ticket.projectId,
      ticketId: ticket.parentId ?? ticket.id,
    }),
    enabled: !!ticket.parentId,
  });
  const children = useQuery(
    api.query("list_tickets", {
      projectId: ticket.projectId,
      parentId: ticket.id,
      archived: "include",
      limit: 20,
      offset,
    }),
  );
  const add = useOperation("add_relation"),
    remove = useOperation("remove_relation");
  return (
    <section>
      <SectionHeading
        compact
        title="Relationships"
        action={
          access.canWrite && (
            <DropdownMenu>
              <DropdownMenuTrigger render={<IconButton label="Add relationship" />}>
                <Plus />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem
                  onClick={() => {
                    add.reset();
                    setValidationError(undefined);
                    setTarget(null);
                    setOpen(true);
                  }}
                >
                  <Unlink />
                  Link existing ticket
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setCreatingChild(true)}>
                  <GitBranchPlus />
                  New child ticket
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )
        }
      />
      {ticket.parentId && (
        <Item size="xs" className="px-0">
          <CornerLeftUp className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <ItemContent className="min-w-0">
            <span className="text-xs text-muted-foreground">Parent</span>
            <TicketLink
              projectId={ticket.projectId}
              ticketId={ticket.parentId}
              ticket={parent.data?.ticket}
            />
          </ItemContent>
        </Item>
      )}
      {children.data && (children.data.total > 0 || offset > 0) && (
        <>
          <h3 className="mt-3 mb-1 text-xs text-muted-foreground">
            Child tickets{" "}
            <span className="tabular-nums">
              {children.data.items.filter((child) => child.status === "done").length}/
              {children.data.total}
            </span>
          </h3>
          <ItemGroup className="gap-0">
            {children.data.items.map((child) => (
              <Item size="xs" className="px-0" key={child.id}>
                <TicketIndicator property="status" value={child.status} iconOnly />
                <ItemContent className="min-w-0">
                  <TicketLink projectId={ticket.projectId} ticketId={child.id} ticket={child} />
                </ItemContent>
              </Item>
            ))}
          </ItemGroup>
          {(children.data.total > 20 || offset > 0) && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                disabled={!offset}
                onClick={() => setOffset(Math.max(0, offset - 20))}
              >
                Previous children
              </Button>
              <Button
                size="sm"
                disabled={offset + 20 >= children.data.total}
                onClick={() => setOffset(offset + 20)}
              >
                Next children
              </Button>
            </div>
          )}
        </>
      )}
      <ItemGroup className="gap-0">
        {relations.data?.map((relation) => {
          const reference = relationReference(relation, ticket.id);
          return (
            <Item size="xs" className="px-0" key={relation.id}>
              <ItemContent className="min-w-0 gap-0">
                <span className="text-xs text-muted-foreground">{reference.label}</span>
                <TicketLink projectId={ticket.projectId} ticketId={reference.id}>
                  {reference.title}
                </TicketLink>
              </ItemContent>
              {access.canWrite && (
                <ItemActions>
                  <IconButton
                    size="icon-sm"
                    label={`Remove ${relation.type} relationship`}
                    onClick={() =>
                      remove.mutate({ projectId: ticket.projectId, relationId: relation.id })
                    }
                  >
                    <Unlink />
                  </IconButton>
                </ItemActions>
              )}
            </Item>
          );
        })}
      </ItemGroup>
      {!ticket.parentId && !children.data?.total && relations.data?.length === 0 && (
        <p className="mb-0 text-xs text-muted-foreground">No relationships</p>
      )}
      <Modal title="Add relationship" open={open} onOpenChange={setOpen} busy={add.isPending}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            if (!target) return;
            setValidationError(undefined);
            void add
              .mutateAsync({
                projectId: ticket.projectId,
                ticketId: ticket.id,
                targetId: target,
                ...parseRelationChoice(form.get("type")),
              })
              .then(() => setOpen(false))
              .catch(setValidationError);
          }}
        >
          <Select label="Relationship" name="type">
            {relationChoices.map((choice) => (
              <SelectItem key={choice.value} value={choice.value}>
                {choice.label}
              </SelectItem>
            ))}
          </Select>
          <TicketPicker
            projectId={ticket.projectId}
            label="Ticket"
            value={target}
            onChange={setTarget}
            exclude={[ticket.id]}
            allowClear={false}
          />

          <FormActions
            error={validationError ?? add.error}
            pending={add.isPending}
            submitLabel="Add relationship"
            submitDisabled={!target}
            onCancel={() => setOpen(false)}
          />
        </form>
      </Modal>
      <Modal
        size="composer"
        title={`New child of ${ticket.key}`}
        open={creatingChild}
        onOpenChange={setCreatingChild}
      >
        {creatingChild && (
          <Suspense fallback={<Loading />}>
            <TicketEditor
              projectId={ticket.projectId}
              initial={{ parentId: ticket.id, labels: ticket.labels, scopes: ticket.scopes }}
              onSaved={() => setCreatingChild(false)}
            />
          </Suspense>
        )}
      </Modal>
      <ErrorNotice error={relations.error ?? remove.error ?? parent.error ?? children.error} />
    </section>
  );
}
