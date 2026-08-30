// Where a URL is allowed to go. `startsWith("http")` is not a scheme check -
// http-calculator: and httpsanything: are valid schemes that pass it and reach
// the OS's protocol handlers, so everything is parsed and compared by origin.
export const SITE_ORIGIN = "https://libecity.com";

export type UrlKind = "internal" | "external" | "reject";

export function classifyUrl(url: string | undefined): UrlKind {
  if (!url) return "reject";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "reject";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "reject";
  return parsed.origin === SITE_ORIGIN ? "internal" : "external";
}
