import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

/** One secret per launched session: a session can act only as itself, and the UI token never works on /v1 (SPEC 10.3). */
export class SessionTokens {
  private readonly bySlug = new Map<string, string>();
  private readonly byToken = new Map<string, string>();

  issue(slug: string): string {
    this.revoke(slug);
    const token = createToken();
    this.bySlug.set(slug, token);
    this.byToken.set(token, slug);
    return token;
  }

  tokenFor(slug: string): string | undefined { return this.bySlug.get(slug); }

  slugFor(token: string): string | undefined {
    // Compare against every issued token in constant time per comparison; the number of sessions is small.
    for (const [t, slug] of this.byToken) if (tokensEqual(t, token)) return slug;
    return undefined;
  }

  revoke(slug: string): void {
    const t = this.bySlug.get(slug);
    if (t) { this.byToken.delete(t); this.releaseKeys.delete(t); }
    this.bySlug.delete(slug);
  }

  /**
   * The release key (SPEC 15.5): a second secret the mod holds in memory, never in the environment, so the session's model cannot read it
   * with a shell command the way it can read the token. It is handed out once per token and only as the session's first request after
   * `session.start`: once the token did anything else (a turn, a guard question, a tool), no key is issued for it any more. `null`: spent.
   */
  private readonly releaseKeys = new Map<string, string | null>();

  /** The token did something: from now on no release key is issued for it. */
  touch(token: string): void {
    if (!this.releaseKeys.has(token)) this.releaseKeys.set(token, null);
  }

  /** The release key of this token, the first time only; undefined afterwards (or after the token was used for anything else). */
  issueReleaseKey(token: string): string | undefined {
    if (this.releaseKeys.has(token) || this.slugFor(token) === undefined) return undefined;
    const key = createToken();
    this.releaseKeys.set(token, key);
    return key;
  }

  /** Whether `key` is the release key issued to this token. */
  checkReleaseKey(token: string, key: unknown): boolean {
    const k = this.releaseKeys.get(token);
    return typeof k === 'string' && typeof key === 'string' && tokensEqual(k, key);
  }
}

export const createToken = (): string => randomBytes(32).toString('base64url');

/**
 * Single-use codes for opening the page: the address the console prints, the app window and a notification click carry a code, never the
 * token. The page swaps the code for the token once (`POST /api/session`), so an address left in a history or a log opens nothing.
 * A code lives for `ttlMs` and at most `max` are alive at once (the oldest goes first).
 */
export class LoginCodes {
  private readonly live = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now, private readonly ttlMs = 12 * 60 * 60_000, private readonly max = 64) {}

  issue(): string {
    const code = createToken();
    this.live.set(code, this.now() + this.ttlMs);
    while (this.live.size > this.max) this.live.delete(this.live.keys().next().value as string);
    return code;
  }

  /** True once per code; an unknown, used or expired one is refused. */
  redeem(code: string): boolean {
    for (const [known, until] of this.live) {
      if (!tokensEqual(known, code)) continue;
      this.live.delete(known);
      return until > this.now();
    }
    return false;
  }
}

export function tokensEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Host header must be loopback on our port: blocks DNS-rebinding (SPEC 4.5). */
export const isAllowedHost = (host: string | undefined, port: number): boolean =>
  host === `127.0.0.1:${port}` || host === `localhost:${port}`;

/** Browsers always send Origin on WebSocket upgrades; a foreign or missing one is refused. */
export const isAllowedOrigin = (origin: string | undefined, port: number): boolean =>
  origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;

export function extractToken(headers: IncomingHttpHeaders, url: URL): string | undefined {
  const auth = headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  return url.searchParams.get('token') ?? undefined;
}

/**
 * Content-Security-Policy of the page: only the console's own scripts run (no inline script, no eval, no foreign origin), the page
 * talks only to this server (HTTP and WebSocket) and cannot be framed. Inline styles stay allowed: the terminal and the markdown view
 * set them. `blob:` serves the microphone recording of the dictation.
 */
export const PAGE_CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "media-src 'self' blob:",
  "connect-src 'self' ws://127.0.0.1:* ws://localhost:*", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join('; ');
