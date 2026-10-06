/**
 * Route protection rules (PRD P1-11). Pure functions so they can be tested without
 * a request. The proxy applies them on every navigation.
 */

/** Areas that need a signed-in user. */
export const PROTECTED_PREFIXES = ["/learn", "/teach", "/admin", "/create"] as const;

/** Pages only for signed-out users. A signed-in visitor is sent to the learner home. */
export const AUTH_PAGES = ["/sign-in", "/sign-up"] as const;

export const SIGN_IN_PATH = "/sign-in";
export const DEFAULT_AFTER_SIGN_IN = "/learn";

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PREFIXES.some((prefix) => matchesPrefix(pathname, prefix));
}

export function isAuthPage(pathname: string): boolean {
  return AUTH_PAGES.some((page) => matchesPrefix(pathname, page));
}

/**
 * Accepts a post-sign-in destination only if it is a path on this site. Anything
 * else (absolute URLs, protocol-relative `//host`, backslash tricks) falls back to
 * the default, so the `next` parameter cannot be used as an open redirect.
 */
export function safeNextPath(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) {
    return DEFAULT_AFTER_SIGN_IN;
  }
  // Reject control characters that browsers strip before parsing the URL.
  if (/[\u0000-\u001f]/.test(next)) return DEFAULT_AFTER_SIGN_IN;
  return next;
}

/** The sign-in URL that returns the visitor to `destination` afterwards. */
export function signInPathFor(destination: string): string {
  const params = new URLSearchParams({ next: destination });
  return `${SIGN_IN_PATH}?${params.toString()}`;
}

export type AccessDecision = { action: "allow" } | { action: "redirect"; location: string };

/** What to do with a request, given the path and whether the visitor is signed in. */
export function decideAccess(options: {
  pathname: string;
  search?: string;
  isSignedIn: boolean;
}): AccessDecision {
  const { pathname, search = "", isSignedIn } = options;
  if (!isSignedIn && isProtectedPath(pathname)) {
    return { action: "redirect", location: signInPathFor(`${pathname}${search}`) };
  }
  if (isSignedIn && isAuthPage(pathname)) {
    return { action: "redirect", location: DEFAULT_AFTER_SIGN_IN };
  }
  return { action: "allow" };
}
