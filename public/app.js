'use strict';

const $ = (id) => document.getElementById(id);
const state = { authenticated: false, simklOAuth: false, simklEnvToken: false, pmdbEnvToken: false, profiles: [] };
const drafts = new Map();
let loadSequence = 0;

function node(tag, attributes = {}, children = []) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null) continue;
    if (key === 'text') element.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') element.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'className') element.className = value;
    else if (key in element && !key.startsWith('aria')) element[key] = value;
    else element.setAttribute(key, String(value));
  }
  for (const child of children) element.append(child);
  return element;
}

function button(text, onClick, className = 'button button-secondary', extra = {}) {
  return node('button', { type: 'button', className, text, onClick, ...extra });
}

function field(text, input) {
  return node('label', { className: 'field' }, [node('span', { text }), input]);
}

function showMessage(text, tone = 'error') {
  const message = $('message');
  message.textContent = text;
  message.dataset.tone = tone;
  message.hidden = false;
  message.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  if (tone === 'error') message.focus({ preventScroll: true });
}

function clearMessage() {
  $('message').hidden = true;
  $('message').textContent = '';
}

function showView() {
  $('loading').hidden = true;
  $('login-view').hidden = state.authenticated;
  $('dashboard').hidden = !state.authenticated;
  $('logout').hidden = !state.authenticated;
}

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && state.authenticated) {
      state.authenticated = false;
      state.profiles = [];
      drafts.clear();
      $('profiles').replaceChildren();
      showView();
    }
    const detail = typeof result.error === 'string' ? result.error : typeof result.message === 'string' ? result.message : `La requête a échoué (HTTP ${response.status}).`;
    throw new Error(detail);
  }
  return result;
}

async function runBusy(target, action) {
  if (target.dataset.busy === 'true') return;
  target.dataset.busy = 'true';
  const controls = target.matches('button') ? [target] : [...target.querySelectorAll('button, input, select')];
  const disabled = controls.map((control) => control.disabled);
  controls.forEach((control) => { control.disabled = true; });
  target.setAttribute('aria-busy', 'true');
  clearMessage();
  try { await action(); }
  catch (error) { showMessage(error instanceof Error ? error.message : 'Une erreur est survenue. Réessayez.'); }
  finally {
    controls.forEach((control, index) => { control.disabled = disabled[index]; });
    target.removeAttribute('aria-busy');
    delete target.dataset.busy;
  }
}

function profilePath(profile, suffix = '') {
  return `/api/profiles/${encodeURIComponent(profile.id)}${suffix}`;
}

function connectionPanel(profile, provider) {
  const name = provider === 'simkl' ? 'SIMKL' : 'PMDB';
  const connection = profile.connections?.[provider];
  const connected = Boolean(connection?.connected);
  const panel = node('div', { className: 'connection' });
  panel.append(node('div', { className: 'connection-heading' }, [
    node('h4', { text: name }),
    node('span', { className: `badge ${connected ? 'badge-success' : ''}`, text: connected ? 'Connecté' : 'À connecter' }),
  ]));

  if (connection?.error) panel.append(node('p', { className: 'connection-error', text: connection.error }));
  const actions = node('div', { className: 'connection-actions' });
  if (provider === 'simkl' && state.simklOAuth && !connected) {
    actions.append(button('Autoriser avec SIMKL', (event) => runBusy(event.currentTarget, async () => {
      const result = await api(profilePath(profile, '/oauth/simkl'), { method: 'POST', body: {} });
      const url = new URL(result.url);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('URL d’autorisation non valide.');
      window.location.assign(url.href);
    }), 'button button-secondary button-small'));
  }
  if (connected) {
    actions.append(button('Déconnecter', (event) => runBusy(event.currentTarget, async () => {
      await api(profilePath(profile, `/connections/${provider}`), { method: 'DELETE' });
      await loadProfiles();
      showMessage(`${name} a été déconnecté de « ${profile.name} ».`, 'success');
    }), 'button button-quiet button-small'));
  }
  if (actions.childElementCount) panel.append(actions);
  if (connected) {
    panel.append(node('p', { text: 'Pour changer de compte, déconnectez celui-ci. Les envois en attente de ce compte seront supprimés.' }));
    return panel;
  }

  if (provider === 'simkl' && !state.simklOAuth) {
    panel.append(node('p', { text: 'OAuth SIMKL n’est pas configuré sur le serveur. Vous pouvez utiliser un jeton d’accès.' }));
  }
  const envToken = provider === 'simkl' ? state.simklEnvToken : state.pmdbEnvToken;
  if (envToken) {
    panel.append(node('p', { text: `Laissez le champ vide pour utiliser le jeton ${name} défini sur le serveur.` }));
  }
  const token = node('input', {
    type: 'password', name: `${provider}Token`, autocomplete: 'off', spellcheck: false,
    required: !envToken,
    placeholder: envToken ? 'Jeton du serveur par défaut' : 'Jeton d’accès personnel',
  });
  const form = node('form', { className: 'connection-form' });
  form.append(field(provider === 'simkl' ? 'Jeton d’accès SIMKL (access_token)' : 'Jeton PMDB', token));
  form.append(node('button', { type: 'submit', className: 'button button-secondary', text: 'Connecter' }));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = token.value.trim();
    runBusy(form, async () => {
      await api(profilePath(profile, `/connections/${provider}`), { method: 'POST', body: value ? { token: value } : {} });
      token.value = '';
      await loadProfiles();
      showMessage(`${name} connecté au profil « ${profile.name} ».`, 'success');
    });
  });
  panel.append(form);
  return panel;
}

function routingPanel(profile) {
  const values = drafts.get(profile.id) || profile;
  const section = node('section');
  section.append(node('h3', { className: 'section-label', text: '02 / SYNCHRONISATION' }));
  const form = node('form', { className: 'routing-form' });
  const name = node('input', { type: 'text', value: values.name, name: 'name', required: true, maxLength: 100, autocomplete: 'off' });
  const pull = node('select', { name: 'pullProvider', 'aria-label': 'Source de récupération de l’historique' });
  [['', 'Aucune — récupération désactivée'], ['simkl', 'SIMKL'], ['pmdb', 'PMDB']].forEach(([value, text]) => {
    pull.append(node('option', { value, text, selected: value === (values.pullProvider || '') }));
  });
  const push = node('fieldset', { className: 'push-fieldset' }, [node('legend', { text: '↑ Envoyer les lectures vers' })]);
  const options = node('div', { className: 'push-options' });
  const pushControls = ['simkl', 'pmdb'].map((provider) => {
    const input = node('input', { type: 'checkbox', name: 'pushProvider', value: provider, checked: (values.pushProviders || []).includes(provider) });
    options.append(node('label', { className: 'checkbox-label' }, [input, node('span', { text: provider.toUpperCase() })]));
    return input;
  });
  push.append(options);
  const consent = node('input', { type: 'checkbox', name: 'consent', checked: Boolean(values.consent) });
  form.append(field('Nom du profil', name), field('↓ Récupérer l’historique depuis', pull));
  form.append(node('p', { className: 'hint', text: 'La récupération utilise une seule source. Les événements de lecture sont envoyés à chaque destination sélectionnée.' }));
  form.append(push);
  form.append(node('label', { className: 'checkbox-label consent-label' }, [consent, node('span', { text: 'J’autorise la lecture et la transmission de mon historique et de ma progression aux services sélectionnés. Sans cet accord, la synchronisation est désactivée.' })]));
  form.append(node('button', { type: 'submit', className: 'button button-primary', text: 'Enregistrer la configuration' }));
  const draftHint = node('p', { className: 'hint', text: 'Modifications non enregistrées.', hidden: !drafts.has(profile.id), role: 'status' });
  form.append(draftHint);
  const readValues = () => ({ name: name.value, pullProvider: pull.value || null, pushProviders: pushControls.filter((input) => input.checked).map((input) => input.value), consent: consent.checked });
  const retainDraft = () => { drafts.set(profile.id, readValues()); draftHint.hidden = false; };
  form.addEventListener('input', retainDraft);
  form.addEventListener('change', retainDraft);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const body = { ...readValues(), name: name.value.trim() };
    if (!body.name) { showMessage('Donnez un nom au profil.'); name.focus(); return; }
    runBusy(form, async () => {
      await api(profilePath(profile), { method: 'PUT', body });
      drafts.delete(profile.id);
      await loadProfiles();
      showMessage(`Configuration de « ${body.name} » enregistrée.`, 'success');
    });
  });
  section.append(form);
  return section;
}

function installPanel(profile) {
  const section = node('section', { className: 'install-section' });
  section.append(node('h3', { className: 'section-label', text: '03 / INSTALLATION' }));
  section.append(node('p', { text: 'Ajoutez cette URL comme addon tracker dans AIOStreams (branche feat/jellyfin).' }));
  const url = node('input', { type: 'text', value: profile.manifestUrl || '', readOnly: true, className: 'manifest-url', 'aria-label': `URL du manifeste du profil ${profile.name}` });
  const copy = button('Copier l’URL', (event) => runBusy(event.currentTarget, async () => {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(profile.manifestUrl);
      showMessage('URL du profil copiée.', 'success');
    } else {
      url.focus(); url.select();
      if (document.execCommand('copy')) showMessage('URL du profil copiée.', 'success');
      else showMessage('URL sélectionnée : copiez-la avec le menu de votre navigateur.', 'info');
    }
  }), 'button button-secondary', { disabled: !profile.manifestUrl });
  const row = node('div', { className: 'manifest-row' }, [url, copy]);
  if (typeof profile.manifestUrl === 'string' && /^https?:\/\//i.test(profile.manifestUrl)) {
    row.append(node('a', { className: 'button button-secondary', text: 'Ouvrir Stremio ↗', href: profile.manifestUrl.replace(/^https?:\/\//i, 'stremio://') }));
  }
  section.append(row);
  section.append(node('p', { className: 'manifest-help', text: 'Cette URL contient l’accès à ce profil : gardez-la confidentielle. La fonction de suivi nécessite un client compatible avec la ressource watch-state.' }));
  return section;
}

function profileFooter(profile) {
  const footer = node('div', { className: 'profile-footer' });
  const jobs = profile.jobs || {};
  const counts = node('div', { className: 'job-info', 'aria-label': 'État des envois' });
  [['pending', 'en attente'], ['blocked', 'bloqués'], ['failed', 'en échec']].forEach(([key, label]) => {
    counts.append(node('span', {}, [node('strong', { text: Number(jobs[key] || 0) }), document.createTextNode(` ${label}`)]));
  });
  const actions = node('div', { className: 'profile-tools' });
  actions.append(button('↻ Récupérer maintenant', (event) => runBusy(event.currentTarget, async () => {
    await api(profilePath(profile, '/refresh'), { method: 'POST', body: {} });
    await loadProfiles();
    showMessage('Récupération demandée. Actualisez la page pour voir le résultat.', 'success');
  }), 'button button-secondary button-small'));
  actions.append(button('Réessayer les envois', (event) => runBusy(event.currentTarget, async () => {
    await api(profilePath(profile, '/retry'), { method: 'POST', body: {} });
    await loadProfiles();
    showMessage('Les envois en attente de reprise ont été relancés.', 'success');
  }), 'button button-secondary button-small'));
  actions.append(button('Renouveler l’URL', (event) => {
    if (!window.confirm(`Renouveler l’URL de « ${profile.name} » ? L’ancienne URL ne fonctionnera plus. Vous devrez remplacer l’addon dans vos clients.`)) return;
    runBusy(event.currentTarget, async () => {
      await api(profilePath(profile, '/rotate'), { method: 'POST', body: {} });
      await loadProfiles();
      showMessage('URL renouvelée. Remplacez l’ancienne URL dans AIOStreams et vos autres clients.', 'success');
    });
  }, 'button button-quiet button-small'));
  footer.append(counts, actions);
  return footer;
}

function diagnosticsPanel(profile) {
  const details = node('details', { className: 'jobs-details' });
  const content = node('div', { className: 'jobs-content' });
  details.append(node('summary', { text: 'Derniers envois et diagnostics' }), content);
  let loaded = false;
  const refresh = async () => {
    const result = await api(profilePath(profile, '/jobs'));
    const jobs = Array.isArray(result.jobs) ? result.jobs : [];
    const states = { pending: 'En attente', running: 'En cours', done: 'Terminé', blocked: 'Bloqué', failed: 'Échec', cancelled: 'Annulé' };
    const list = node('ul', { className: 'jobs-list' });
    for (const job of jobs) {
      const label = `${String(job.provider || '').toUpperCase()} · ${String(job.event || 'événement')}`;
      const row = node('li', {}, [node('div', { className: 'job-heading' }, [
        node('strong', { text: label }),
        node('span', { className: `badge ${['blocked', 'failed'].includes(job.status) ? 'badge-error' : job.status === 'done' ? 'badge-success' : ''}`, text: states[job.status] || String(job.status) }),
      ]), node('p', { text: `${Number(job.attempts || 0)} tentative(s)` })]);
      if (job.error) row.append(node('p', { className: ['blocked', 'failed'].includes(job.status) ? 'connection-error' : 'hint', text: job.error }));
      list.append(row);
    }
    const reload = button('Actualiser les diagnostics', (event) => runBusy(event.currentTarget, refresh), 'button button-secondary button-small');
    content.replaceChildren(jobs.length ? list : node('p', { className: 'hint', text: 'Aucun envoi pour ce profil.' }), reload);
    loaded = true;
  };
  details.addEventListener('toggle', () => {
    if (details.open && !loaded) runBusy(content, refresh);
  });
  return details;
}

function renderProfile(profile) {
  const article = node('article', { className: 'profile-card', 'aria-label': `Profil ${profile.name}` });
  const active = Boolean(profile.consent && (profile.pullProvider || profile.pushProviders?.length));
  const failing = Boolean(profile.syncError || Number(profile.jobs?.failed) || Number(profile.jobs?.blocked));
  const title = node('div');
  title.append(node('div', { className: 'profile-title-row' }, [
    node('h2', { text: profile.name }),
    node('span', { className: `badge ${failing ? 'badge-warning' : active ? 'badge-success' : ''}`, text: failing ? 'À vérifier' : active ? 'Synchronisation autorisée' : 'Non activé' }),
  ]));
  let syncText = 'Aucune récupération effectuée';
  if (profile.lastSync) {
    const raw = Number(profile.lastSync);
    const date = new Date(raw < 1e12 ? raw * 1000 : raw);
    if (!Number.isNaN(date.getTime())) syncText = `Dernière récupération : ${date.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}`;
  }
  title.append(node('p', { className: 'profile-meta', text: syncText }));
  const remove = button('Supprimer', (event) => {
    if (!window.confirm(`Supprimer le profil « ${profile.name} », ses connexions et son URL d’addon ? Cette action est définitive.`)) return;
    runBusy(event.currentTarget, async () => {
      await api(profilePath(profile), { method: 'DELETE' });
      drafts.delete(profile.id);
      await loadProfiles();
      showMessage(`Profil « ${profile.name} » supprimé.`, 'success');
    });
  }, 'button button-danger button-small');
  article.append(node('div', { className: 'profile-header' }, [title, remove]));
  const connectionSection = node('section', {}, [node('h3', { className: 'section-label', text: '01 / COMPTES CONNECTÉS' }), node('div', { className: 'connections' }, [connectionPanel(profile, 'simkl'), connectionPanel(profile, 'pmdb')])]);
  article.append(node('div', { className: 'profile-content' }, [connectionSection, routingPanel(profile)]));
  if (profile.syncError) article.append(node('p', { className: 'profile-error', text: `La récupération a échoué : ${profile.syncError}` }));
  article.append(installPanel(profile), diagnosticsPanel(profile), profileFooter(profile));
  return article;
}

async function loadProfiles() {
  const sequence = ++loadSequence;
  const result = await api('/api/profiles');
  if (sequence !== loadSequence || !state.authenticated) return;
  state.profiles = Array.isArray(result.profiles) ? result.profiles : [];
  if (state.profiles.length) $('profiles').replaceChildren(...state.profiles.map(renderProfile));
  else $('profiles').replaceChildren(node('div', { className: 'empty-state' }, [
    node('span', { className: 'empty-symbol', text: '↔', 'aria-hidden': 'true' }),
    node('h2', { text: 'Votre premier profil vous attend' }),
    node('p', { text: 'Créez un profil ci-dessus, puis connectez SIMKL, PMDB ou les deux.' }),
  ]));
}

$('login-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const apiKey = $('api-key').value.trim();
  if (!apiKey) return;
  runBusy(event.currentTarget, async () => {
    await api('/api/login', { method: 'POST', body: { apiKey } });
    $('api-key').value = '';
    Object.assign(state, await api('/api/status'));
    if (!state.authenticated) throw new Error('La session n’a pas pu être ouverte. Vérifiez que les cookies sont autorisés et que l’URL du serveur est correcte.');
    showView();
    await loadProfiles();
  });
});

$('logout').addEventListener('click', (event) => runBusy(event.currentTarget, async () => {
  await api('/api/logout', { method: 'POST', body: {} });
  state.authenticated = false;
  state.profiles = [];
  drafts.clear();
  ++loadSequence;
  $('profiles').replaceChildren();
  showView();
  $('api-key').focus();
}));

$('reload').addEventListener('click', (event) => runBusy(event.currentTarget, async () => {
  await loadProfiles();
  showMessage('Profils actualisés.', 'success');
}));

$('create-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const name = $('profile-name').value.trim();
  if (!name) { showMessage('Donnez un nom au profil.'); $('profile-name').focus(); return; }
  runBusy(event.currentTarget, async () => {
    await api('/api/profiles', { method: 'POST', body: { name, pullProvider: null, pushProviders: [], consent: false } });
    $('profile-name').value = '';
    await loadProfiles();
    showMessage(`Profil « ${name} » créé. Connectez vos comptes pour continuer.`, 'success');
  });
});

async function initialize() {
  try {
    Object.assign(state, await api('/api/status'));
    showView();
    if (state.authenticated) await loadProfiles();
  } catch (error) {
    showView();
    showMessage(error instanceof Error ? error.message : 'Impossible de joindre le serveur.');
  }
}

initialize();
