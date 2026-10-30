import { expect, it } from "vite-plus/test";
import { deliverySettingsInput } from "./configuration.ts";

it("clears edited destination fields while retaining untouched write-only secrets", () => {
  const edited = deliverySettingsInput("telegram", { chatId: " 123 ", topicId: "" }, true);
  expect(edited).toMatchObject({ kind: "telegram", chatId: "123", topicId: "" });
  expect(edited).not.toHaveProperty("botToken");
  expect(deliverySettingsInput("ntfy", { topic: "tasks" }, true, ["token"])).toHaveProperty(
    "token",
    "",
  );
  expect(deliverySettingsInput("telegram", { chatId: "123" }, false)).not.toHaveProperty("topicId");
});
