/** How much of the audit runs: nothing, the zero-token measures and the project's commands, or those plus the model. */
export const AUDIT_LEVELS = ['off', 'metrics', 'full'] as const;
export type AuditLevel = (typeof AUDIT_LEVELS)[number];
