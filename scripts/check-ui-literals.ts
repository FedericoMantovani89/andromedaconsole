// Fails the build on user-visible literal strings in UI code and on .focus() outside src/ui/focus.ts (P2, P12).
import { readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { findUiLiterals, findStrayFocus, findTextOnlyButtons } from '../src/shared/i18n-checks';
import { walk } from './walk.ts';

const root = resolve(import.meta.dirname, '..');
const uiDir = join(root, 'src', 'ui');

/**
 * Buttons that are allowed to show text, each with its reason ("file:variable"). A button of an action is an icon with its words in the
 * tooltip; these are the ones whose text is data (a list entry, a time) or a tab, not the name of an action.
 */
const BUTTON_ALLOW: Record<string, string> = {
  'options.ts:b': 'a tab of the Options dialog: a tab names a page, it does not act',
  'project-tabs.ts:tab': 'a project tab: the project name is data',
  'queue.ts:b': 'an option of a question: its words are the data of the question, written by the agent',
  'reader.ts:b': 'an entry of the list of turns: a selection, with the turn number',
  'time-picker.ts:button': 'it shows the time chosen',
  'time-picker.ts:hourBtn': 'it shows the hour chosen',
  'time-picker.ts:minBtn': 'it shows the minute chosen',
};

let failures = 0;
for (const file of walk(uiDir)) {
  const text = readFileSync(file, 'utf8');
  const rel = file.replace(root + sep, '');
  for (const f of findUiLiterals(text, file)) {
    console.error(`ui-literal: ${rel}:${f.line} literal visible text "${f.text}" (use t())`);
    failures++;
  }
  for (const b of findTextOnlyButtons(text)) {
    if (BUTTON_ALLOW[`${rel.split(sep).pop()}:${b.name}`]) continue;
    console.error(`text-button: ${rel}:${b.line} button "${b.name || '(not kept)'}" is not an icon button (use setIconButton: icon, words in the tooltip)`);
    failures++;
  }
  if (!file.endsWith(`${sep}focus.ts`)) {
    for (const line of findStrayFocus(text)) {
      console.error(`stray-focus: ${rel}:${line} .focus() outside src/ui/focus.ts (P2)`);
      failures++;
    }
  }
}
if (failures > 0) process.exit(1);
console.log('ui: no literal visible text, no stray focus(), no text-only button');
