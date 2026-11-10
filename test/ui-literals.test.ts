import { it, expect } from 'vitest';
import { findUiLiterals, findStrayFocus } from '../src/shared/i18n-checks';

it('flags literal text assigned to visible properties', () => {
  const src = "el.textContent = 'Hello world';\nbtn.title = \"Close\";\nel.setAttribute('aria-label', 'Close panel');";
  expect(findUiLiterals(src, 'x.ts').map((f) => f.line)).toEqual([1, 2, 3]);
});
it('allows keys, class names, tags and console output', () => {
  const src = "el.textContent = t('panel.main');\nel.className = 'panel active';\ndocument.createElement('div');\nconsole.log('state changed here');";
  expect(findUiLiterals(src, 'x.ts')).toEqual([]);
});
it('flags a stray focus() call and ignores comments', () => {
  expect(findStrayFocus('// term.focus()\nterm.focus();\nconst x = 1;')).toEqual([2]);
});

import { findTextOnlyButtons } from '../src/shared/i18n-checks';

it('flags a button that is not an icon button, and accepts one that is', () => {
  const src = "const a = el('button');\nbindText(a, 'common.save');\nconst b = document.createElement('button');\nsetIconButton(b, 'check', 'common.save');\nparent.append(el('button'));";
  expect(findTextOnlyButtons(src)).toEqual([{ line: 1, name: 'a' }, { line: 5, name: '' }]);
});
it('follows a button kept in a variable that is assigned later', () => {
  const src = "let r: HTMLButtonElement | undefined;\nr = el('button', 'x');\nsetIconButton(r, 'trash', 'k');";
  expect(findTextOnlyButtons(src)).toEqual([]);
});
