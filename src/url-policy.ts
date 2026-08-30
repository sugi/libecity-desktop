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

// Where the main window itself is allowed to go. Wider than `internal`: the
// site spans subdomains, and a login (password or phone, per the captured
// traffic) never leaves them. Anything else is a foreign page wearing this
// app's window, so it is sent to the browser instead.
const SITE_HOST = "libecity.com";

export function mayNavigate(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  return parsed.hostname === SITE_HOST || parsed.hostname.endsWith(`.${SITE_HOST}`);
}
