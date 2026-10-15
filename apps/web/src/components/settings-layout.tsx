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
        className="grid min-w-0 items-start grid-cols-1 gap-7 lg:grid-cols-[170px_minmax(0,1fr)] lg:gap-12"
      >
        <TabsList
          variant="line"
          aria-label={`${title} sections`}
          className="h-fit! w-full self-start flex-row items-stretch justify-start overflow-x-auto p-0 lg:flex-col lg:overflow-visible"
        >
          {sections.map((section) => (
            <TabsTrigger
              key={section.id}
              value={section.id}
              className="h-10 flex-none justify-start gap-2 px-3 text-left lg:w-full"
            >
              <section.icon />
              {section.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <div className="settings mx-0 min-w-0 max-w-5xl">{children}</div>
      </Tabs>
    </>
  );
}
