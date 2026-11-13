import type { Config } from '../config';
import type { ProjectInfo } from '../project-store';

export type AuditSettings = Config['audit'];

/** What applies to one project: each project field, when set, beats the global value (a project `false` still beats a global `true`). */
export function effectiveAudit(global: AuditSettings, project: Pick<ProjectInfo, 'auditLevel' | 'auditAutoModel' | 'auditProfile'>): AuditSettings {
  return {
    level: project.auditLevel ?? global.level,
    autoModel: project.auditAutoModel ?? global.autoModel,
    profile: project.auditProfile ?? global.profile,
  };
}
