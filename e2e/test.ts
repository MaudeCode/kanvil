// The shared entry for browser specs. Each case still gets its own fresh context; this records the
// real browser work it used: contexts, pages, and sign-in submissions from a page.
import { test as base, type BrowserContext } from "@playwright/test";

export { expect } from "@playwright/test";
const signInPaths = /^\/api\/(auth\/sign-in\/|v1\/setup$)/;
export const test = base.extend<{ accounting: void }>({
  accounting: [
    async ({ browser, context }, use, testInfo) => {
      const counts = { contexts: 0, pages: 0, signInForms: 0 };
      const watch = (target: BrowserContext) => {
        counts.contexts++;
        counts.pages += target.pages().length;
        target.on("page", () => counts.pages++);
        target.on("request", (request) => {
          if (request.method() === "POST" && signInPaths.test(new URL(request.url()).pathname))
            counts.signInForms++;
        });
      };
      watch(context);
      const newContext = browser.newContext.bind(browser);
      browser.newContext = async (...options) => {
        const created = await newContext(...options);
        watch(created);
        return created;
      };
      await use();
      browser.newContext = newContext;
      testInfo.annotations.push({ type: "kanvil.boundaries", description: JSON.stringify(counts) });
    },
    { auto: true },
  ],
});
