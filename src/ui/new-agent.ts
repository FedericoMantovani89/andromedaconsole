import type { ApiError } from '../shared/protocol';
import { api } from './api';
import { bindText, t } from './i18n-client';
import { focusElementFromUser } from './focus';
import { el } from './dom';
import { setIconButton } from './icons';

/** Translates a server error code (SPEC 5.9: the server sends codes and parameters, never sentences). */
export function errorText(err: ApiError): string {
  const text = t('error.' + err.code, err.params);
  return text === `error.${err.code}` ? t('error.generic') : text;
}

/**
 * The "+ new agent" control. Opening the form is a user click, so moving the cursor into the slug field is allowed;
 * creating an agent never moves the keyboard anywhere (the new panel appears dimmed, P2).
 */
export function createNewAgentControl(getProfiles: () => readonly string[], afterCreate: () => void, getRepos: () => readonly string[] = () => []): HTMLElement {
  const wrap = el('div', 'new-agent-wrap');
  const button = el('button');
  button.id = 'new-agent-btn';
  setIconButton(button, 'plus', 'panel.newAgent');
  wrap.append(button);

  button.addEventListener('click', () => {
    const form = el('form', 'new-agent-form');

    const slugLabel = el('label');
    const slugText = el('span');
    bindText(slugText, 'panel.slugLabel');
    const slug = el('input');
    slug.name = 'slug';
    slug.autocomplete = 'off';
    slugLabel.append(slugText, slug);

    const profileLabel = el('label');
    const profileText = el('span');
    bindText(profileText, 'panel.profileLabel');
    const profile = el('select');
    profile.name = 'profile';
    for (const p of getProfiles()) {
      const o = el('option');
      o.value = p;
      o.textContent = p; // profile names are data
      profile.append(o);
    }
    profileLabel.append(profileText, profile);

    // A project folder that holds several repositories: the agent works in exactly one of them.
    const repoNames = getRepos().filter((r) => r !== '');
    const repoLabel = el('label');
    const repo = el('select');
    repo.name = 'repo';
    if (repoNames.length > 1) {
      const repoText = el('span');
      bindText(repoText, 'panel.repoLabel');
      for (const r of repoNames) {
        const o = el('option');
        o.value = r;
        o.textContent = r; // repo names are data
        repo.append(o);
      }
      repoLabel.append(repoText, repo);
    }

    const error = el('div', 'form-error');
    const actions = el('div', 'form-actions');
    const create = el('button');
    create.type = 'submit';
    setIconButton(create, 'check', 'common.create');
    const cancel = el('button');
    cancel.type = 'button';
    setIconButton(cancel, 'x', 'common.cancel');
    actions.append(create, cancel);
    form.append(slugLabel, profileLabel, repoLabel, error, actions);

    const close = () => { form.remove(); button.hidden = false; afterCreate(); };
    cancel.addEventListener('click', close);
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      void api<ApiError | { slug: string }>('/api/agents', { method: 'POST', body: { slug: slug.value, profile: profile.value, ...(repoNames.length > 1 ? { repo: repo.value } : {}) } })
        .then((res) => {
          if (res.status === 201 || res.status === 202) close(); // 202: queued behind the limit, it starts by itself
          else error.textContent = errorText(res.body as ApiError);
        });
    });

    button.hidden = true;
    wrap.append(form);
    focusElementFromUser(slug, 'user');
  });
  return wrap;
}
