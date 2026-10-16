import { PageHeader, Select, SelectItem } from "../ui.tsx";
import { Item, ItemContent, ItemTitle, ItemDescription, ItemActions } from "@/components/ui/item";
import { useIsMobile } from "../hooks/use-mobile.ts";
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
export function SettingsLayout({
  title,
  value,
  onChange,
  sections,
  children,
}: {
  title: string;
  value: string;
  onChange: (value: string) => void;
  sections: readonly { id: string; label: string; icon: LucideIcon }[];
  children: ReactNode;
}) {
  const mobile = useIsMobile(1024);
  return (
    <>
      <PageHeader title={title} />
      <Tabs
        orientation={mobile ? "horizontal" : "vertical"}
        value={value}
        onValueChange={(next) => onChange(String(next))}
        className="grid min-w-0 items-start grid-cols-1 gap-5 lg:grid-cols-[160px_minmax(0,1fr)] lg:gap-9"
      >
        {mobile && (
          <Select
            label={`${title} section`}
            labelHidden
            className="mb-0"
            value={value}
            onValueChange={(next) => {
              if (next) onChange(next);
            }}
          >
            {sections.map((section) => (
              <SelectItem key={section.id} value={section.id}>
                <section.icon className="size-4" />
                {section.label}
              </SelectItem>
            ))}
          </Select>
        )}
        <TabsList
          hidden={mobile}
          variant="line"
          aria-label={`${title} sections`}
          className={
            mobile ? "hidden" : "h-fit! w-full self-start flex-col items-stretch justify-start p-0"
          }
        >
          {sections.map((section) => (
            <TabsTrigger
              key={section.id}
              value={section.id}
              className="h-8 flex-none justify-start gap-2 px-3 text-left lg:w-full"
            >
              <section.icon />
              {section.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <div className="settings @container mx-0 max-w-5xl min-w-0 [&_form]:max-w-none [&_p]:text-sm [&_p]:text-muted-foreground [&_section]:border-t [&_section]:py-5 [&_section:first-child]:border-0 [&_section:first-child]:pt-0 [&>[data-slot=tabs-content]>section:first-child]:border-0 [&>[data-slot=tabs-content]>section:first-child]:pt-0">
          {children}
        </div>
      </Tabs>
    </>
  );
}

export function SettingRow({
  title,
  description,
  children,
  compact = false,
}: {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  compact?: boolean;
}) {
  return (
    <Item
      className={cn(
        "setting-row rounded-none border-x-0 border-t-0 border-b-border px-0",
        compact ? "flex-nowrap py-2" : "py-3.5 @max-[28rem]:flex-col @max-[28rem]:items-stretch",
      )}
    >
      <ItemContent className={compact ? "min-w-0 gap-0.5" : undefined}>
        <ItemTitle className={compact ? "line-clamp-none max-w-full" : undefined}>
          {title}
        </ItemTitle>
        {description && (
          <ItemDescription
            className={cn("line-clamp-none max-w-xl whitespace-normal", compact && "m-0 text-xs")}
          >
            {description}
          </ItemDescription>
        )}
      </ItemContent>
      {children && (
        <ItemActions className={compact ? "shrink-0" : "@max-[28rem]:justify-start"}>
          {children}
        </ItemActions>
      )}
    </Item>
  );
}
