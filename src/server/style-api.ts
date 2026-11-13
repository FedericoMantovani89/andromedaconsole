import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { SLUG_RE } from '../shared/slug';
import { fail, readObjectBody, send } from './http-util';
import {
  LIMIT_RANGES, listStyleProfiles, loadStyleProfile, parseStyleProfile, serializeStyleProfile, styleFileFor, styleFilesOf,
  type LimitId, type StyleProfile, type StyleSource,
} from './audit/style-profile';

/** What the style routes need from the console; the token and Host checks already ran. */
export interface StyleHost {
  projectRoot: string;
  /** The user's folder of style profiles (in the config folder). */
  userDir: string;
  /** The profile names in force: the global one, the project's own when set, and the one that applies. */
  active(): { global: string; project?: string; effective: string };
}

type Scope = Exclude<StyleSource, 'shipped'>;
const isScope = (v: unknown): v is Scope => v === 'user' || v === 'project';
const MAX_NAME = 40;

function describe(name: string, host: StyleHost): Record<string, unknown> | undefined {
  const p = loadStyleProfile(name, host.projectRoot, host.userDir);
  if (!p) return undefined;
  const files = styleFilesOf(name, host.projectRoot, host.userDir);
  return { name, source: p.source, description: p.description, shipped: files.shipped, userFile: files.user, projectFile: files.project };
}

function writeText(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, text, 'utf8');
  renameSync(`${file}.tmp`, file);
}

/** A refused profile: the answer names the limit and the range it has to be in (UI-CONVENTIONS: errors name the limits). */
function refuse(res: ServerResponse, r: { code: 'style.badLimit' | 'style.badCommand'; params: { key: string } }): void {
  if (r.code === 'style.badLimit' && r.params.key in LIMIT_RANGES) {
    const [min, max] = LIMIT_RANGES[r.params.key as LimitId];
    fail(res, 422, r.code, { key: r.params.key, min, max });
  } else fail(res, 422, r.code, r.params);
}

/**
 * The style profiles of the audit (SPEC 15.7): `GET /api/style` (the list and what is active), `GET|PUT|DELETE /api/style/<name>` and
 * `POST /api/style/<name>/duplicate`. A profile is one `.md` file; PUT takes its text as written (an import is the same call), GET gives
 * it back (an export is that text saved by the browser). Returns false for any other path.
 */
export async function handleStyleRoute(host: StyleHost, req: IncomingMessage, res: ServerResponse, path: string, url: URL): Promise<boolean> {
  if (path === '/api/style') {
    if (req.method !== 'GET') return false;
    send(res, 200, { profiles: listStyleProfiles(host.projectRoot, host.userDir).flatMap((p) => describe(p.name, host) ?? []), active: host.active() });
    return true;
  }
  const m = /^\/api\/style\/([a-z0-9-]+)(\/duplicate)?$/.exec(path);
  if (!m) return false;
  const name = m[1]!;
  if (m[2]) {
    if (req.method !== 'POST') return false;
    const b = await readObjectBody(req, res);
    if (!b) return true;
    const to = typeof b.to === 'string' ? b.to : '';
    const scope = b.scope ?? 'user';
    if (!SLUG_RE.test(to) || to.length > MAX_NAME) { fail(res, 422, 'style.badName'); return true; }
    if (!isScope(scope)) { fail(res, 422, 'style.badScope'); return true; }
    const from = loadStyleProfile(name, host.projectRoot, host.userDir);
    if (!from) { fail(res, 404, 'style.notFound'); return true; }
    const target = styleFileFor(to, scope, host.projectRoot, host.userDir);
    if (existsSync(target)) { fail(res, 409, 'style.exists'); return true; }
    writeText(target, serializeStyleProfile({ ...from, name: to } satisfies StyleProfile));
    send(res, 200, describe(to, host) ?? {});
    return true;
  }
  if (req.method === 'GET') {
    const p = loadStyleProfile(name, host.projectRoot, host.userDir);
    if (!p) { fail(res, 404, 'style.notFound'); return true; }
    const file = styleFileFor(name, p.source, host.projectRoot, host.userDir);
    send(res, 200, { profile: p, text: readFileSync(file, 'utf8'), ...describe(name, host) });
    return true;
  }
  if (req.method === 'PUT') {
    const b = await readObjectBody(req, res);
    if (!b) return true;
    if (!isScope(b.scope)) { fail(res, 422, 'style.badScope'); return true; }
    if (typeof b.text !== 'string') { fail(res, 400, 'bad_request'); return true; }
    const parsed = parseStyleProfile(b.text, name, b.scope);
    if (!parsed.ok) { refuse(res, parsed); return true; }
    writeText(styleFileFor(name, b.scope, host.projectRoot, host.userDir), b.text);
    send(res, 200, describe(name, host) ?? {});
    return true;
  }
  if (req.method === 'DELETE') {
    const scope = url.searchParams.get('scope');
    if (!isScope(scope)) { fail(res, 422, 'style.badScope'); return true; }
    const file = styleFileFor(name, scope, host.projectRoot, host.userDir);
    if (!existsSync(file)) { fail(res, 404, 'style.notFound'); return true; }
    unlinkSync(file);
    send(res, 200, { name });
    return true;
  }
  return false;
}
