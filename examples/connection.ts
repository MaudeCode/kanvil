export function exampleConnection() {
  const baseUrl = process.env.KANVIL_URL,
    key = process.env.KANVIL_API_KEY;
  if (!baseUrl || !key) throw new Error("Set KANVIL_URL and KANVIL_API_KEY in the environment.");
  const url = new URL(baseUrl);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("KANVIL_URL must be the server origin without credentials or a path.");
  return { baseUrl: url.origin, key };
}
