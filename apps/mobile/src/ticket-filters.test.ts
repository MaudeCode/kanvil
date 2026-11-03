import { expect, it } from "vite-plus/test";
import { filterFieldLabels, filterFieldNames, ticketFilter } from "@kanvil/contracts";
import { fixedFilterChoices } from "./ticket-filters.ts";

it("offers agent readiness in the filter menu with values the server accepts", () => {
  expect(filterFieldNames).toContain("automation");
  expect(filterFieldLabels.automation).toBe("Agent readiness");
  const { automation } = fixedFilterChoices();
  expect(automation).toEqual([
    { value: "ready", label: "Ready for agents" },
    { value: "manual", label: "Needs a person" },
  ]);
  for (const { value } of automation)
    expect(ticketFilter.parse({ automation: value }).automation).toBe(value);
});
