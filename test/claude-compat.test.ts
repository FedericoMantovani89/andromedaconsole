import { describe, expect, it } from 'vitest';
import { buildClaudeLaunch } from '../src/server/claude-code/launch';
import { CLAUDE_FLAGS } from '../src/server/claude-code/compat';

describe('claude-code compat list', () => {
  it('names every flag the launch can pass, so the contract run checks them all', () => {
    const { args } = buildClaudeLaunch({
      command: ['claude'], role: 'agent', slug: 'a', project: 'p', url: 'http://127.0.0.1:1', token: 't', bypass: true, baseEnv: {}, platform: 'linux',
      pluginDir: '/m', appendPromptFile: '/p.md', model: 'x', allowedTools: ['T'], settingsFile: '/s.json', resumeId: 'abc', displayName: 'n',
    });
    const used = args.filter((a) => a.startsWith('--'));
    expect([...used].sort()).toEqual([...CLAUDE_FLAGS].sort());
  });
});
