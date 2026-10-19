import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { Ticket } from "@kanvil/contracts";
import { api } from "../data.tsx";
import { TicketIndicator } from "../ui.tsx";
import { TicketTag } from "./ticket-tags.tsx";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { cn } from "@/lib/utils";

// Every cross-reference to a ticket shares this link and its hover preview.
export function TicketLink({
  projectId,
  ticketId,
  ticket,
  hash,
  className,
  children,
}: {
  projectId: string;
  ticketId: string;
  ticket?: Pick<Ticket, "key" | "title"> | undefined;
  // An anchor within the ticket page, such as a comment.
  hash?: string | undefined;
  className?: string;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const preview = useQuery({
    ...api.query("get_ticket", { projectId, ticketId }),
    enabled: open,
  });
  const detail = preview.data?.ticket;
  return (
    <HoverCard open={open} onOpenChange={setOpen}>
      <HoverCardTrigger
        delay={400}
        render={
          <Link
            to="/projects/$projectId/tickets/$ticketId"
            params={{ projectId, ticketId }}
            {...(hash ? { hash } : {})}
            className={cn("ticket-link text-foreground hover:text-primary", className)}
          />
        }
      >
        {children ??
          (ticket ? (
            <>
              <span className="font-mono text-[11px] text-muted-foreground">{ticket.key}</span>
              {" · "}
              {ticket.title}
            </>
          ) : (
            ticketId
          ))}
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-80">
        {detail ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="font-mono">{detail.key}</span>
              <TicketIndicator property="status" value={detail.status} />
              <TicketIndicator property="priority" value={detail.priority} iconOnly />
            </div>
            <p className="m-0 text-[13px] leading-5 font-medium wrap-anywhere">{detail.title}</p>
            {detail.labels.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {detail.labels.map((label) => (
                  <TicketTag key={label} tag={label} />
                ))}
              </div>
            )}
          </div>
        ) : (
          <p className="m-0 text-xs text-muted-foreground">
            {preview.error ? "Preview unavailable" : "Loading…"}
          </p>
        )}
      </HoverCardContent>
    </HoverCard>
  );
}
