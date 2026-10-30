// Only first-party image endpoints may receive an account's image request headers.
export function serverImageURI(baseUrl: string, uri: string): string | null {
  const absolute = uri.startsWith("/") && !uri.startsWith("//") ? `${baseUrl}${uri}` : uri;
  if (!absolute.startsWith(`${baseUrl}/api/v1/`)) return null;
  const path = absolute.slice(baseUrl.length).split("?")[0] ?? "";
  return /^\/api\/v1\/(?:users\/[^/\\]+\/photo|projects\/[^/\\]+\/(?:icon|background|attachments\/[^/\\]+\/content))$/.test(
    path,
  )
    ? absolute
    : null;
}
