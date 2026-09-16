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
    const detail = typeof result.error === 'string' ? result.error : typeof result.message === 'string' ? result.message : `Request failed (HTTP ${response.status}).`;
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
  catch (error) { showMessage(error instanceof Error ? error.message : 'Something went wrong. Please try again.'); }
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
    node('span', { className: `badge ${connected ? 'badge-success' : ''}`, text: connected ? 'Connected' : 'Not connected' }),
  ]));

  if (connection?.error) panel.append(node('p', { className: 'connection-error', text: connection.error }));
  const actions = node('div', { className: 'connection-actions' });
  if (provider === 'simkl' && state.simklOAuth && !connected) {
    actions.append(button('Authorize with SIMKL', (event) => runBusy(event.currentTarget, async () => {
      const result = await api(profilePath(profile, '/oauth/simkl'), { method: 'POST', body: {} });
      const url = new URL(result.url);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Invalid authorization URL.');
      window.location.assign(url.href);
    }), 'button button-secondary button-small'));
  }
  if (connected) {
    actions.append(button('Disconnect', (event) => runBusy(event.currentTarget, async () => {
      await api(profilePath(profile, `/connections/${provider}`), { method: 'DELETE' });
      await loadProfiles();
      showMessage(`${name} disconnected from “${profile.name}”.`, 'success');
    }), 'button button-quiet button-small'));
  }
  if (actions.childElementCount) panel.append(actions);
  if (connected) {
    panel.append(node('p', { text: 'To switch accounts, disconnect this account first. Its queued events will be deleted.' }));
    return panel;
  }

  if (provider === 'simkl' && !state.simklOAuth) {
    panel.append(node('p', { text: 'SIMKL OAuth is not configured on this server. You can connect with an access token.' }));
  }
  const envToken = provider === 'simkl' ? state.simklEnvToken : state.pmdbEnvToken;
  if (envToken) {
    panel.append(node('p', { text: `Leave this field empty to use the ${name} token configured on the server.` }));
  }
  const token = node('input', {
    type: 'password', name: `${provider}Token`, autocomplete: 'off', spellcheck: false,
    required: !envToken,
    placeholder: envToken ? 'Default server token' : 'Personal access token',
  });
  const form = node('form', { className: 'connection-form' });
  form.append(field(provider === 'simkl' ? 'SIMKL access token (access_token)' : 'PMDB token', token));
  form.append(node('button', { type: 'submit', className: 'button button-secondary', text: 'Connect' }));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = token.value.trim();
    runBusy(form, async () => {
      await api(profilePath(profile, `/connections/${provider}`), { method: 'POST', body: value ? { token: value } : {} });
      token.value = '';
      await loadProfiles();
      showMessage(`${name} connected to “${profile.name}”.`, 'success');
    });
  });
  panel.append(form);
  return panel;
}

function routingPanel(profile) {
  const values = drafts.get(profile.id) || profile;
  const section = node('section');
  section.append(node('h3', { className: 'section-label', text: '02 / SYNC SETTINGS' }));
  const form = node('form', { className: 'routing-form' });
  const name = node('input', { type: 'text', value: values.name, name: 'name', required: true, maxLength: 100, autocomplete: 'off' });
  const pull = node('select', { name: 'pullProvider', 'aria-label': 'Watch history pull source' });
  [['', 'None — pull disabled'], ['simkl', 'SIMKL'], ['pmdb', 'PMDB']].forEach(([value, text]) => {
    pull.append(node('option', { value, text, selected: value === (values.pullProvider || '') }));
  });
  const push = node('fieldset', { className: 'push-fieldset' }, [node('legend', { text: '↑ Push playback events to' })]);
  const options = node('div', { className: 'push-options' });
  const pushControls = ['simkl', 'pmdb'].map((provider) => {
    const input = node('input', { type: 'checkbox', name: 'pushProvider', value: provider, checked: (values.pushProviders || []).includes(provider) });
    options.append(node('label', { className: 'checkbox-label' }, [input, node('span', { text: provider.toUpperCase() })]));
    return input;
  });
  push.append(options);
  const consent = node('input', { type: 'checkbox', name: 'consent', checked: Boolean(values.consent) });
  form.append(field('Profile name', name), field('↓ Pull watch history from', pull));
  form.append(node('p', { className: 'hint', text: 'Watch history is pulled from one source. Playback events are sent to every selected destination.' }));
  form.append(push);
  form.append(node('label', { className: 'checkbox-label consent-label' }, [consent, node('span', { text: 'I allow my watch history and playback progress to be read from and sent to the selected services. Sync stays disabled without this permission.' })]));
  form.append(node('button', { type: 'submit', className: 'button button-primary', text: 'Save settings' }));
  const draftHint = node('p', { className: 'hint', text: 'Unsaved changes.', hidden: !drafts.has(profile.id), role: 'status' });
  form.append(draftHint);
  const readValues = () => ({ name: name.value, pullProvider: pull.value || null, pushProviders: pushControls.filter((input) => input.checked).map((input) => input.value), consent: consent.checked });
  const retainDraft = () => { drafts.set(profile.id, readValues()); draftHint.hidden = false; };
  form.addEventListener('input', retainDraft);
  form.addEventListener('change', retainDraft);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const body = { ...readValues(), name: name.value.trim() };
    if (!body.name) { showMessage('Enter a profile name.'); name.focus(); return; }
    runBusy(form, async () => {
      await api(profilePath(profile), { method: 'PUT', body });
      drafts.delete(profile.id);
      await loadProfiles();
      showMessage(`Settings saved for “${body.name}”.`, 'success');
    });
  });
  section.append(form);
  return section;
}

function installPanel(profile) {
  const section = node('section', { className: 'install-section' });
  section.append(node('h3', { className: 'section-label', text: '03 / INSTALLATION' }));
  section.append(node('p', { text: 'Add this URL as a tracker addon in AIOStreams (feat/jellyfin branch).' }));
  const url = node('input', { type: 'text', value: profile.manifestUrl || '', readOnly: true, className: 'manifest-url', 'aria-label': `Manifest URL for ${profile.name}` });
  const copy = button('Copy URL', (event) => runBusy(event.currentTarget, async () => {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(profile.manifestUrl);
      showMessage('Profile URL copied.', 'success');
    } else {
      url.focus(); url.select();
      if (document.execCommand('copy')) showMessage('Profile URL copied.', 'success');
      else showMessage('URL selected. Copy it using your browser menu.', 'info');
    }
  }), 'button button-secondary', { disabled: !profile.manifestUrl });
  const row = node('div', { className: 'manifest-row' }, [url, copy]);
  if (typeof profile.manifestUrl === 'string' && /^https?:\/\//i.test(profile.manifestUrl)) {
    row.append(node('a', { className: 'button button-secondary', text: 'Open Stremio ↗', href: profile.manifestUrl.replace(/^https?:\/\//i, 'stremio://') }));
  }
  section.append(row);
  section.append(node('p', { className: 'manifest-help', text: 'This URL grants access to this profile. Keep it private. Tracking requires a client that supports the watch-state resource.' }));
  return section;
}

function profileFooter(profile) {
  const footer = node('div', { className: 'profile-footer' });
  const jobs = profile.jobs || {};
  const counts = node('div', { className: 'job-info', 'aria-label': 'Push queue status' });
  [['pending', 'pending'], ['blocked', 'blocked'], ['failed', 'failed']].forEach(([key, label]) => {
    counts.append(node('span', {}, [node('strong', { text: Number(jobs[key] || 0) }), document.createTextNode(` ${label}`)]));
  });
  const actions = node('div', { className: 'profile-tools' });
  actions.append(button('↻ Pull now', (event) => runBusy(event.currentTarget, async () => {
    await api(profilePath(profile, '/refresh'), { method: 'POST', body: {} });
    await loadProfiles();
    showMessage('Pull requested. Refresh the page to see the result.', 'success');
  }), 'button button-secondary button-small'));
  actions.append(button('Retry events', (event) => runBusy(event.currentTarget, async () => {
    await api(profilePath(profile, '/retry'), { method: 'POST', body: {} });
    await loadProfiles();
    showMessage('Queued retries have been restarted.', 'success');
  }), 'button button-secondary button-small'));
  actions.append(button('Rotate URL', (event) => {
    if (!window.confirm(`Rotate the URL for “${profile.name}”? The old URL will stop working. You will need to replace the addon in your clients.`)) return;
    runBusy(event.currentTarget, async () => {
      await api(profilePath(profile, '/rotate'), { method: 'POST', body: {} });
      await loadProfiles();
      showMessage('URL rotated. Replace the old URL in AIOStreams and your other clients.', 'success');
    });
  }, 'button button-quiet button-small'));
  footer.append(counts, actions);
  return footer;
}

function playbackTime(milliseconds) {
  if (typeof milliseconds !== 'number' || !Number.isFinite(milliseconds) || milliseconds < 0) return 'unknown';
  const seconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
    : `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

function eventTimestamp(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return 'Time unknown';
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime())
    ? 'Time unknown'
    : date.toLocaleString('en', { dateStyle: 'short', timeStyle: 'medium' });
}

function diagnosticsPanel(profile) {
  const details = node('details', { className: 'jobs-details' });
  const content = node('div', { className: 'jobs-content' });
  details.append(node('summary', { text: 'Recent events and diagnostics' }), content);
  let loaded = false;
  const refresh = async () => {
    const result = await api(profilePath(profile, '/jobs'));
    const jobs = Array.isArray(result.jobs) ? result.jobs : [];
    const states = { pending: 'Pending', running: 'Running', done: 'Done', blocked: 'Blocked', failed: 'Failed', cancelled: 'Cancelled' };
    const list = node('ul', { className: 'jobs-list' });
    for (const job of jobs) {
      const label = `${String(job.provider || '').toUpperCase()} · ${String(job.event || 'event')}`;
      const row = node('li', {}, [node('div', { className: 'job-heading' }, [
        node('strong', { text: label }),
        node('span', { className: `badge ${['blocked', 'failed'].includes(job.status) ? 'badge-error' : job.status === 'done' ? 'badge-success' : ''}`, text: states[job.status] || String(job.status) }),
      ])]);
      const contentId = job.videoId || job.metaId || 'unknown';
      row.append(node('p', { className: 'job-meta', text: `${eventTimestamp(job.at)} · Content: ${String(contentId)}` }));
      const validPosition = typeof job.positionMs === 'number' && Number.isFinite(job.positionMs) && job.positionMs >= 0;
      const validDuration = typeof job.durationMs === 'number' && Number.isFinite(job.durationMs) && job.durationMs > 0;
      const progress = validPosition && validDuration ? ` (${(job.positionMs / job.durationMs * 100).toFixed(1)}%)` : '';
      const played = typeof job.played === 'boolean' ? ` · Played: ${job.played ? 'yes' : 'no'}` : '';
      row.append(node('p', { text: `Position: ${playbackTime(job.positionMs)} / ${validDuration ? playbackTime(job.durationMs) : 'unknown'}${progress}${played}` }));
      const attempts = Number(job.attempts || 0);
      row.append(node('p', { text: `${attempts} ${attempts === 1 ? 'attempt' : 'attempts'}` }));
      if (job.error) row.append(node('p', { className: ['blocked', 'failed'].includes(job.status) ? 'connection-error' : 'hint', text: job.error }));
      list.append(row);
    }
    const reload = button('Refresh diagnostics', (event) => runBusy(event.currentTarget, refresh), 'button button-secondary button-small');
    content.replaceChildren(jobs.length ? list : node('p', { className: 'hint', text: 'No events for this profile yet.' }), reload);
    loaded = true;
  };
  details.addEventListener('toggle', () => {
    if (details.open && !loaded) runBusy(content, refresh);
  });
  return details;
}

function renderProfile(profile) {
  const article = node('article', { className: 'profile-card', 'aria-label': `Profile ${profile.name}` });
  const active = Boolean(profile.consent && (profile.pullProvider || profile.pushProviders?.length));
  const failing = Boolean(profile.syncError || Number(profile.jobs?.failed) || Number(profile.jobs?.blocked));
  const title = node('div');
  title.append(node('div', { className: 'profile-title-row' }, [
    node('h2', { text: profile.name }),
    node('span', { className: `badge ${failing ? 'badge-warning' : active ? 'badge-success' : ''}`, text: failing ? 'Needs attention' : active ? 'Sync enabled' : 'Disabled' }),
  ]));
  let syncText = 'No pull completed yet';
  if (profile.lastSync) {
    const raw = Number(profile.lastSync);
    const date = new Date(raw < 1e12 ? raw * 1000 : raw);
    if (!Number.isNaN(date.getTime())) syncText = `Last pull: ${date.toLocaleString('en', { dateStyle: 'short', timeStyle: 'short' })}`;
  }
  title.append(node('p', { className: 'profile-meta', text: syncText }));
  const remove = button('Delete', (event) => {
    if (!window.confirm(`Delete “${profile.name}”, its connections and its addon URL? This cannot be undone.`)) return;
    runBusy(event.currentTarget, async () => {
      await api(profilePath(profile), { method: 'DELETE' });
      drafts.delete(profile.id);
      await loadProfiles();
      showMessage(`Profile “${profile.name}” deleted.`, 'success');
    });
  }, 'button button-danger button-small');
  article.append(node('div', { className: 'profile-header' }, [title, remove]));
  const connectionSection = node('section', {}, [node('h3', { className: 'section-label', text: '01 / CONNECTED ACCOUNTS' }), node('div', { className: 'connections' }, [connectionPanel(profile, 'simkl'), connectionPanel(profile, 'pmdb')])]);
  article.append(node('div', { className: 'profile-content' }, [connectionSection, routingPanel(profile)]));
  if (profile.syncError) article.append(node('p', { className: 'profile-error', text: `Pull failed: ${profile.syncError}` }));
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
    node('h2', { text: 'Create your first profile' }),
    node('p', { text: 'Create a profile above, then connect SIMKL, PMDB or both.' }),
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
    if (!state.authenticated) throw new Error('Unable to sign in. Check that cookies are enabled and the server URL is correct.');
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
  showMessage('Profiles refreshed.', 'success');
}));

$('create-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const name = $('profile-name').value.trim();
  if (!name) { showMessage('Enter a profile name.'); $('profile-name').focus(); return; }
  runBusy(event.currentTarget, async () => {
    await api('/api/profiles', { method: 'POST', body: { name, pullProvider: null, pushProviders: [], consent: false } });
    $('profile-name').value = '';
    await loadProfiles();
    showMessage(`Profile “${name}” created. Connect your accounts to continue.`, 'success');
  });
});

async function initialize() {
  try {
    Object.assign(state, await api('/api/status'));
    showView();
    if (state.authenticated) await loadProfiles();
  } catch (error) {
    showView();
    showMessage(error instanceof Error ? error.message : 'Unable to reach the server.');
  }
}

initialize();
