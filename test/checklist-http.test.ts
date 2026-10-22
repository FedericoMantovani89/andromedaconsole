import { it, expect } from 'vitest';
import { autoClose, usePipePty, bootServer, ui } from './helpers';

autoClose();
usePipePty(); // this file never reads the terminal: its sessions run on plain pipes

it('the checklist of an agent without a ticket is empty, and the route needs the UI token', async () => {
  const s = await bootServer();
  expect((await ui(s, '/api/agents/ghost-job/checklist')).body).toEqual({ steps: [] });
});
