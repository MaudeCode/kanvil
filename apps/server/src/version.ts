import metadata from "../../../package.json" with { type: "json" };

declare const KANVIL_BUILD_VERSION: string;

export const applicationVersion =
  typeof KANVIL_BUILD_VERSION === "undefined" ? metadata.version : KANVIL_BUILD_VERSION;
