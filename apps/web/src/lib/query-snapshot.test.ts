import { expect, it } from "vite-plus/test";
import { QueryClient, QueryObserver, replaceEqualDeep } from "@tanstack/react-query";
import { createQuerySnapshot } from "./query-snapshot.ts";

it("retains canonical query data after the useQueries structural-sharing boundary", () => {
  const client = new QueryClient();
  const observer = new QueryObserver<{ items: { id: string }[] }>(client, {
    queryKey: ["page"],
    initialData: { items: [{ id: "before" }] },
  });
  const combine = createQuerySnapshot<{ items: { id: string }[] }>();
  const before = combine([observer.getCurrentResult()]);
  client.setQueryData(["page"], { items: [{ id: "after" }] });
  observer.updateResult();
  const canonical = observer.getCurrentResult().data;
  const after = replaceEqualDeep(before, combine([observer.getCurrentResult()]));
  expect(after.pages[0]).toBe(canonical);
  const progress = combine([observer.getCurrentResult()]);
  expect(progress.pages).toBe(after.pages);
  expect(combine([observer.getCurrentResult()])).toBe(progress);
  client.clear();
});
