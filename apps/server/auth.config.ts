import { createDatabase } from "./src/database.ts";
import { readConfig } from "./src/config.ts";
import { createAuth } from "./src/auth.ts";

const config = readConfig();
export const auth = createAuth(createDatabase(config), config);
