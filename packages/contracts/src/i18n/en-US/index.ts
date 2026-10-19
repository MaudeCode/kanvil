import common from "./common.ts";
import shell from "./shell.ts";
import ticket from "./ticket.ts";
import detail from "./detail.ts";
import settings from "./settings.ts";
import admin from "./admin.ts";
import native from "./native.ts";
// The source catalog. Every other locale has these sections and keys; English is also the
// fallback for any key a locale lacks.
export default { common, shell, ticket, detail, settings, admin, native };
