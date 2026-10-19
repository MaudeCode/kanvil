// Fake GitHub, Google, and Discord OAuth endpoints for the sign-in suites. Installed in place of
// `fetch`, they answer the provider hosts and pass every other request through, so no request
// reaches a real provider. An authorization code carries the identity it grants.
import { generateKeyPairSync, sign } from "node:crypto";
import { z } from "zod";

const identitySchema = z.object({
  id: z.string(),
  email: z.string(),
  verified: z.boolean(),
  // Breaks the Google ID token this identity receives.
  invalid: z.enum(["signature", "audience"]).optional(),
});
export type FakeIdentity = z.infer<typeof identitySchema>;
export const fakeOAuthCode = (identity: FakeIdentity) =>
  Buffer.from(JSON.stringify(identity)).toString("base64url");
const identityOf = (code: string) => {
  try {
    return identitySchema.parse(JSON.parse(Buffer.from(code, "base64url").toString()));
  } catch {
    return undefined;
  }
};
const hosts = new Set([
  "github.com",
  "api.github.com",
  "discord.com",
  "oauth2.googleapis.com",
  "www.googleapis.com",
]);
const tokenEndpoints = new Set([
  "https://github.com/login/oauth/access_token",
  "https://discord.com/api/oauth2/token",
  "https://oauth2.googleapis.com/token",
]);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export function fakeOAuthProviders(real: typeof fetch, googleClientId: string) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const key = { ...publicKey.export({ format: "jwk" }), kid: "fake-google", alg: "RS256" };
  // The PKCE verifiers the token endpoints received, oldest first.
  const verifiers: string[] = [];
  function googleToken(claims: Record<string, unknown>, invalidSignature = false) {
    const body = `${Buffer.from(JSON.stringify({ alg: "RS256", kid: "fake-google" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
    const signature = sign("RSA-SHA256", Buffer.from(body), privateKey).toString("base64url");
    return `${body}.${invalidSignature ? "invalid" : signature}`;
  }
  async function answer(call: Request) {
    const url = new URL(call.url),
      address = decodeURIComponent(url.href);
    if (tokenEndpoints.has(address)) {
      const form = new URLSearchParams(await call.text()),
        code = form.get("code") ?? "",
        identity = identityOf(code);
      verifiers.push(form.get("code_verifier") ?? "");
      if (!identity) return json({ error: "bad_verification_code" });
      const now = Math.floor(Date.now() / 1000);
      return json({
        access_token: code,
        token_type: "Bearer",
        expires_in: 300,
        ...(url.hostname === "oauth2.googleapis.com" && {
          id_token: googleToken(
            {
              iss: "https://accounts.google.com",
              aud: identity.invalid === "audience" ? "another-client" : googleClientId,
              sub: identity.id,
              email: identity.email,
              email_verified: identity.verified,
              name: "Google person",
              iat: now,
              exp: now + 300,
            },
            identity.invalid === "signature",
          ),
        }),
      });
    }
    if (address === "https://www.googleapis.com/oauth2/v3/certs") return json({ keys: [key] });
    const identity = identityOf(call.headers.get("authorization")?.replace(/^Bearer /i, "") ?? "");
    if (!identity) return json({}, 401);
    if (address === "https://api.github.com/user")
      return json({ id: Number(identity.id), login: "octo", name: "GitHub person", email: null });
    if (address === "https://api.github.com/user/emails")
      return json([{ email: identity.email, primary: true, verified: identity.verified }]);
    if (address === "https://discord.com/api/users/@me")
      return json({
        id: identity.id,
        username: "discord-person",
        global_name: "Discord person",
        discriminator: "0",
        avatar: null,
        email: identity.email,
        verified: identity.verified,
      });
    return json({}, 404);
  }
  return {
    verifiers,
    googleToken,
    fetch: (input: string | URL | Request, init?: RequestInit) => {
      const call = new Request(input, init);
      return hosts.has(new URL(call.url).hostname) ? answer(call) : real(input, init);
    },
  };
}
