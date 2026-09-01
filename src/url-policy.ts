// Where a URL is allowed to go. `startsWith("http")` is not a scheme check -
// http-calculator: and httpsanything: are valid schemes that pass it and reach
// the OS's protocol handlers, so everything is parsed and compared by host.
export const SITE_ORIGIN = "https://libecity.com";

// The site spans subdomains (api., points-api. and library. all appear in the
// captured traffic), and every one of them is still this app's own site. Only
// a host outside it is a foreign page, and only that belongs in the browser.
const SITE_HOST = "libecity.com";

function isSiteUrl(parsed: URL): boolean {
  if (parsed.protocol !== "https:") return false;
  return parsed.hostname === SITE_HOST || parsed.hostname.endsWith(`.${SITE_HOST}`);
}

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
  return isSiteUrl(parsed) ? "internal" : "external";
}

// Where the main window itself is allowed to go. The same host rule, without
// the reject case: a scheme this app will not open is simply not a navigation
// it permits either.
export function mayNavigate(url: string): boolean {
  try {
    return isSiteUrl(new URL(url));
  } catch {
    return false;
  }
}
