import { expect, it } from "vite-plus/test";
import { serverImageURI } from "./media.ts";
it("keeps account image headers on owned image endpoints", () => {
  const base = "https://kanvil.example.test";
  expect(serverImageURI(base, "/api/v1/projects/project/icon?v=image")).toBe(
    `${base}/api/v1/projects/project/icon?v=image`,
  );
  expect(serverImageURI(base, `${base}/api/v1/users/person/photo`)).toBe(
    `${base}/api/v1/users/person/photo`,
  );
  for (const uri of [
    "//other.example/photo",
    "https://kanvil.example.test.evil.test/api/v1/users/person/photo",
    "https://other.example/api/v1/users/person/photo",
    "/api/v1/redirect",
    "/api/v1/projects/a\\b/icon",
  ])
    expect(serverImageURI(base, uri)).toBeNull();
});
