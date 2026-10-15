import { Select, SelectItem } from "../ui.tsx";
import { Item, ItemContent, ItemTitle, ItemDescription, ItemActions } from "@/components/ui/item";
import { useIsMobile } from "../hooks/use-mobile.ts";
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
      <header className="page-header">
        <h1>{title}</h1>
      </header>
      <Tabs
        orientation={mobile ? "horizontal" : "vertical"}
        value={value}
        onValueChange={(next) => onChange(String(next))}
        className="grid min-w-0 items-start grid-cols-1 gap-5 lg:grid-cols-[160px_minmax(0,1fr)] lg:gap-9"
      >
        {mobile && (
          <Select
            label={`${title} section`}
            className="settings-section-picker mb-0"
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
        <div className="settings @container mx-0 min-w-0 max-w-5xl">{children}</div>
      </Tabs>
    </>
  );
}

export function SettingRow({
  title,
  description,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Item className="setting-row rounded-none border-x-0 border-t-0 border-b-border px-0 py-3.5 @max-[28rem]:flex-col @max-[28rem]:items-stretch">
      <ItemContent>
        <ItemTitle>{title}</ItemTitle>
        {description && (
          <ItemDescription className="line-clamp-none max-w-xl whitespace-normal">
            {description}
          </ItemDescription>
        )}
      </ItemContent>
      {children && <ItemActions className="@max-[28rem]:justify-start">{children}</ItemActions>}
    </Item>
  );
}
