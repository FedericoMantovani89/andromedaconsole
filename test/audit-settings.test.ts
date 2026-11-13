import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyConfigPatch, DEFAULT_CONFIG, validateConfig } from '../src/server/config';
import { isValidProjectField } from '../src/server/project-store';
import { effectiveAudit } from '../src/server/audit/settings';

describe('global audit settings', () => {
  it('default to metrics only, no automatic model part, the default profile', () => {
    expect(DEFAULT_CONFIG.audit).toEqual({ level: 'metrics', autoModel: false, profile: 'default' });
    expect(validateConfig({}).config.audit).toEqual({ level: 'metrics', autoModel: false, profile: 'default' });
  });

  it('accept the three levels, a boolean and a profile slug', () => {
    const { config, errors } = validateConfig({ audit: { level: 'full', autoModel: true, profile: 'strict' } });
    expect(errors).toEqual([]);
    expect(config.audit).toEqual({ level: 'full', autoModel: true, profile: 'strict' });
  });

  it.each([
    [{ level: 'loud' }, 'audit.level'],
    [{ autoModel: 'yes' }, 'audit.autoModel'],
    [{ profile: '../x' }, 'audit.profile'],
    [{ profile: '' }, 'audit.profile'],
  ])('reports %j and keeps the default', (audit, path) => {
    const { config, errors } = validateConfig({ audit });
    expect(errors).toEqual([{ path, code: 'config.invalid' }]);
    expect(config.audit).toEqual(DEFAULT_CONFIG.audit);
  });

  it('can be changed through the generic patch, and a bad value writes nothing', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'audit-cfg-')), 'config.json');
    const bad = applyConfigPatch(file, { audit: { level: 'loud' } });
    expect(bad).toMatchObject({ ok: false, code: 'config.invalid', path: 'audit.level' });
    const good = applyConfigPatch(file, { audit: { level: 'off' } });
    expect(good.ok).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8')).audit).toEqual({ level: 'off' });
  });
});

describe('project audit fields', () => {
  it.each([
    ['auditLevel', 'off', true], ['auditLevel', 'full', true], ['auditLevel', 'loud', false], ['auditLevel', 3, false],
    ['auditAutoModel', true, true], ['auditAutoModel', false, true], ['auditAutoModel', 'true', false],
    ['auditProfile', 'strict', true], ['auditProfile', '../x', false], ['auditProfile', 'Has Space', false],
  ] as const)('%s = %j is %s', (field, value, valid) => {
    expect(isValidProjectField(field, value)).toBe(valid);
  });
});

describe('effectiveAudit', () => {
  const global = { level: 'metrics', autoModel: false, profile: 'default' } as const;
  it('uses the global value for what the project does not set', () => {
    expect(effectiveAudit(global, {})).toEqual(global);
  });
  it('lets the project win field by field', () => {
    expect(effectiveAudit({ level: 'full', autoModel: true, profile: 'default' }, { auditLevel: 'off' })).toEqual({ level: 'off', autoModel: true, profile: 'default' });
    expect(effectiveAudit(global, { auditAutoModel: true, auditProfile: 'strict' })).toEqual({ level: 'metrics', autoModel: true, profile: 'strict' });
  });
  it('a project autoModel of false still overrides a global true', () => {
    expect(effectiveAudit({ level: 'full', autoModel: true, profile: 'default' }, { auditAutoModel: false }).autoModel).toBe(false);
  });
});
