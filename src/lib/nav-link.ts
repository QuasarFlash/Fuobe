/**
 * A link the billing service may ask the top bar to show (Policy.navLink, src/server/billing.ts): its words and a
 * same-site address. The bar shows it beside the balance from md up, and the phone's You sheet first.
 */
export interface NavLink {
  label: string;
  url: string;
}

/** The longest words the bar shows on the link. */
export const NAV_LINK_MAX = 24;

/** The words and address as the bar shows them, or null when either is missing, too long or not a same-site path. */
export function cleanNavLink(raw: unknown): NavLink | null {
  if (!raw || typeof raw !== "object") return null;
  const { label, url } = raw as { label?: unknown; url?: unknown };
  if (typeof label !== "string" || typeof url !== "string") return null;
  const words = label.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  if (!words || words.length > NAV_LINK_MAX) return null;
  if (!url.startsWith("/") || url.startsWith("//") || url.includes("\\") || url.length > 300) return null;
  return { label: words, url };
}

/**
 * The browser's own time zone, an IANA name such as "Asia/Kolkata" or "America/Argentina/Buenos_Aires" (the fuobe_tz
 * cookie, set before the first paint: src/lib/nav.ts), or null when it isn't one.
 */
export function cleanZone(raw: string | null | undefined): string | null {
  if (!raw || raw.length > 64) return null;
  return /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/.test(raw) ? raw : null;
}

/** The cookie the browser's time zone travels in. */
export const ZONE_COOKIE = "fuobe_tz";

/** The browser's time zone from a request's Cookie header, or null when it has none or not a zone name. */
export function zoneOf(cookieHeader: string | null | undefined): string | null {
  for (const part of (cookieHeader ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at < 0 || part.slice(0, at).trim() !== ZONE_COOKIE) continue;
    try {
      return cleanZone(decodeURIComponent(part.slice(at + 1).trim()));
    } catch {
      return null;
    }
  }
  return null;
}
