import type { Catalog } from "../index.ts";
import common from "./common.ts";
import shell from "./shell.ts";
import ticket from "./ticket.ts";
import detail from "./detail.ts";
import settings from "./settings.ts";
import admin from "./admin.ts";
import native from "./native.ts";
export default { common, shell, ticket, detail, settings, admin, native } satisfies Catalog;
