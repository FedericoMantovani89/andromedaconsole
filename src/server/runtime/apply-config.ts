import type { Config } from '../config';
import type { Context } from '../http';
import type { ProjectContainer } from './services';

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Applies a saved configuration patch to the live objects (the Options dialog). */
export function applyConfig(k: ProjectContainer): Context['applyConfig'] {
  const { shared, config, runtime, limits } = k.get('env');
  return (next, applied) => {
    // In place, per sub-object: closures that read `config.budget` / `runtime.git` keep seeing the live object.
    if (isPlain(applied.agents)) {
      // The request settings are read on every use (RequestService deps), so copying them is enough.
      for (const key of ['maxActiveGlobal', 'maxActivePerProject', 'requestTimeoutMinutes', 'requestMaxHops'] as const) {
        if (key in applied.agents) config.agents[key] = next.agents[key];
      }
      limits.global = config.agents.maxActiveGlobal;
      limits.perProject = config.agents.maxActivePerProject;
      for (const r of shared.runtimes) r.parts.scheduler.release();
    }
    if (isPlain(applied.budget)) {
      const { loop, quota, ...flat } = next.budget;
      Object.assign(config.budget, flat);
      Object.assign(config.budget.loop, loop);
      Object.assign(config.budget.quota, quota);
    }
    if (isPlain(applied.git)) {
      for (const key of Object.keys(applied.git) as (keyof Config['git'])[]) Object.assign(runtime.git, { [key]: next.git[key] });
    }
    if (isPlain(applied.audit)) Object.assign(config.audit, next.audit); // read at every use (ticket-flow's AuditService)
    if (isPlain(applied.models)) Object.assign(config.models, next.models);
    if (isPlain(applied.plugins)) Object.assign(config.plugins, next.plugins);
  };
}
