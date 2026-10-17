import { createMcpHandler, McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { requireMcpAuth } from "@better-auth/mcp";
import { z } from "zod";
import { ApiError, operations, isOperation, scopes } from "@kanvil/contracts";
import type { Actor, Domain } from "./domain.ts";
import type { Auth } from "./auth.ts";
import type { Config } from "./config.ts";
import { applicationVersion } from "./version.ts";
import type { createAccess } from "./access.ts";

export function createMcp(
  auth: Auth,
  domain: Domain,
  access: ReturnType<typeof createAccess>,
  config: Config,
  // Counts a write against the caller; OAuth clients are not covered by the credential limiter.
  limitWrite: (key: string) => void,
) {
  const serve = (request: Request, identity: Actor, limited = false) =>
    createMcpHandler(
      () => {
        const server = new McpServer({ name: "Kanvil", version: applicationVersion });
        for (const name of Object.keys(operations).filter(isOperation)) {
          const spec = operations[name];
          const inputSchema: Record<string, z.ZodType> = spec.input.shape;
          server.registerTool(
            name,
            {
              description: spec.description,
              inputSchema,
              outputSchema: { result: spec.output },
              annotations: {
                readOnlyHint: spec.method === "GET",
                destructiveHint: /^(delete|remove|recover)_/.test(name),
                idempotentHint: spec.method === "GET",
                openWorldHint: false,
              },
            },
            async (input: Record<string, unknown>): Promise<CallToolResult> => {
              try {
                if (limited && spec.method !== "GET") limitWrite(identity.ownerId);
                const result = await domain.execute(name, input, identity);
                return {
                  content: [{ type: "text", text: `${name} completed.` }],
                  structuredContent: { result },
                };
              } catch (error) {
                if (!(error instanceof ApiError) && !(error instanceof z.ZodError)) throw error;
                return {
                  isError: true,
                  content: [
                    {
                      type: "text",
                      text:
                        error instanceof ApiError
                          ? `${error.code}: ${error.message}`
                          : "validation_error: Invalid tool arguments",
                    },
                  ],
                };
              }
            },
          );
        }
        return server;
      },
      { legacy: "stateless" },
    ).fetch(request);
  const oauth = requireMcpAuth(
    auth,
    async (request, claims) => {
      if (typeof claims.sub !== "string")
        throw new ApiError(401, "unauthorized", "A user subject is required");
      const granted = typeof claims.scope === "string" ? claims.scope.split(" ") : [];
      const permissions = scopes.filter((scope) => granted.includes(`kanvil:${scope}`));
      const clientId = typeof claims.client_id === "string" ? claims.client_id : "oauth";
      return serve(
        request,
        await domain.actor(claims.sub, {
          ownerId: `${claims.sub}:${clientId}`,
          scopes: permissions,
        }),
        true,
      );
    },
    { resource: `${config.KANVIL_URL}/mcp`, challengeScopes: ["kanvil:read"] },
  );
  return async (request: Request) => {
    if (request.headers.get("authorization")?.match(/^Bearer\s+kv_/i))
      return serve(request, await access.authenticate(request));
    return oauth(request);
  };
}
