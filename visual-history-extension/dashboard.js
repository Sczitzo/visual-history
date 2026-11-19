import {
  ALL_SITES, CATEGORIES, PREFERENCES, STAR_PREFIX, classify, readSettings, ruleTable, webUrl
} from './rules.mjs';
import {dateKey, groupVisits, loadDay, localDay, localMinute, visibleVisits} from './history.mjs';

const $ = id => document.getElementById(id);
const countFormat = new Intl.NumberFormat();
const timeFormat = new Intl.DateTimeFormat(undefined, {hour: 'numeric', minute: '2-digit'});
const captureFormat = new Intl.DateTimeFormat(undefined, {dateStyle: 'medium', timeStyle: 'short'});
const dayFormat = new Intl.DateTimeFormat(undefined, {weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'});
const dayStep = 60;
const dayMinutes = 24 * 60;
const interval = 15;
const state = {
  date: dateKey(),
  view: 'clusters',
  filters: {range: null, search: '', category: '', starred: false},
  prefs: null,
  hasPermission: false,
  rules: [],
  stars: new Set(),
  visits: [],
  incomplete: false,
  failures: 0,
  phase: 'loading',
  limit: dayStep,
  expanded: new Set()
};
let loading;
let refreshTimer;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function countText(count) {
  return countFormat.format(count);
}

function visitsText(count) {
  return countText(count) + (count === 1 ? ' visit' : ' visits');
}

function showNotice(message) {
  $('notice').textContent = message;
  $('settings-notice').textContent = message;
}

async function request(type, fields = {}) {
  const response = await chrome.runtime.sendMessage({type, ...fields});
  if (!response?.ok) throw new Error(response?.error || 'Visual History could not complete the request.');
  return response.value;
}

const tracked = new Map();
const observer = new IntersectionObserver(entries => {
  for (const entry of entries) {
    const card = tracked.get(entry.target);
    if (!card) continue;
    card.visible = entry.isIntersecting && entry.intersectionRatio > 0;
    if (card.visible) showPreview(card);
    else erasePreview(card);
  }
}, {threshold: 0.01});

function erasePreview(card) {
  card.ticket += 1;
  card.requested = false;
  card.image.hidden = true;
  card.image.removeAttribute('src');
  card.label.textContent = 'Generated preview';
}

function updatePreviews(url, reread = true) {
  for (const card of tracked.values()) {
    if (url && card.url !== url) continue;
    erasePreview(card);
    if (reread) showPreview(card);
  }
}

async function showPreview(card) {
  if (!card.visible || card.requested || document.hidden || !webUrl(card.url)) return;
  card.requested = true;
  const ticket = ++card.ticket;
  try {
    const preview = await request('get-preview', {url: card.url});
    if (!preview || ticket !== card.ticket || !card.visible || document.hidden) return;
    if (!preview.image.startsWith('data:image/webp;base64,')) return;
    card.image.onload = () => {
      if (ticket !== card.ticket || document.hidden) return;
      card.image.hidden = false;
      card.label.textContent = 'Captured ' + captureFormat.format(preview.capturedAt);
    };
    card.image.src = preview.image;
  } catch {
    // The generated tile remains available when a cached image cannot be read.
  }
}

function dateHeading() {
  const today = dateKey();
  $('date').max = today;
  $('date').value = state.date;
  $('next-day').disabled = state.date >= today;
  $('day-context').hidden = state.date !== today;
  $('day-title').textContent = dayFormat.format(localDay(state.date).start);
}

const plot = $('timeline-plot');
const startInput = $('range-start');
const endInput = $('range-end');
const bars = Array.from({length: dayMinutes / interval}, () => element('div', 'time-bar'));
let drag;
$('timeline-bars').append(...bars);
for (let minute = 0; minute <= dayMinutes; minute += interval) {
  const label = timeFormat.format(new Date(2000, 0, 1, 0, minute));
  if (minute < dayMinutes) startInput.add(new Option(label, minute));
  if (minute > 0) endInput.add(new Option(minute === dayMinutes ? 'End of day' : label, minute));
}

function paintRange() {
  const {range} = state.filters;
  const start = range?.start ?? 0;
  const end = range?.end ?? dayMinutes;
  startInput.value = start;
  endInput.value = end;
  $('full-day').disabled = state.phase !== 'ready' || !range;
  const shade = $('timeline-range');
  shade.hidden = !range;
  shade.style.left = 100 * start / dayMinutes + '%';
  shade.style.right = 100 * (dayMinutes - end) / dayMinutes + '%';
  for (const [index, bar] of bars.entries()) {
    const minute = index * interval;
    bar.classList.toggle('selected', !!range && minute >= start && minute < end);
  }
}

function updateTimeline() {
  const ready = state.phase === 'ready';
  const counts = Array(bars.length).fill(0);
  if (ready) {
    for (const visit of visibleVisits(state.visits, {...state.filters, range: null}, state.stars)) {
      counts[Math.floor(localMinute(visit.time) / interval)] += 1;
    }
  }
  const total = counts.reduce((sum, count) => sum + count, 0);
  const max = Math.max(1, ...counts);
  $('day-total').textContent = ready
    ? (state.incomplete ? 'Loaded visits · ' + countText(total) : visitsText(total) + ' all day')
    : '';
  for (const [index, bar] of bars.entries()) {
    const count = counts[index];
    bar.classList.toggle('empty', count === 0);
    bar.style.height = count ? 100 * count / max + '%' : '2px';
  }
  startInput.disabled = endInput.disabled = !ready;
  paintRange();
}

function selectRange(start, end) {
  const current = state.filters.range;
  if (start === (current?.start ?? 0) && end === (current?.end ?? dayMinutes)) return;
  state.filters.range = start === 0 && end === dayMinutes ? null : {start, end};
  state.limit = dayStep;
  paintRange();
  renderResults();
}

function minuteAt(x) {
  const rect = plot.getBoundingClientRect();
  const bucket = Math.floor((x - rect.left) / rect.width * bars.length);
  return Math.min(dayMinutes - interval, Math.max(0, bucket * interval));
}

function moveRange(event) {
  if (!drag || event.pointerId !== drag.pointerId) return;
  const minute = minuteAt(event.clientX);
  selectRange(Math.min(drag.anchor, minute), Math.max(drag.anchor, minute) + interval);
}

plot.addEventListener('pointerdown', event => {
  if (state.phase !== 'ready' || !event.isPrimary || event.button !== 0 || drag) return;
  drag = {pointerId: event.pointerId, anchor: minuteAt(event.clientX), original: state.filters.range};
  plot.setPointerCapture(event.pointerId);
  moveRange(event);
});
window.addEventListener('pointermove', moveRange);
window.addEventListener('pointerup', event => {
  if (!drag || event.pointerId !== drag.pointerId) return;
  moveRange(event);
  drag = undefined;
});
window.addEventListener('pointercancel', event => {
  if (!drag || event.pointerId !== drag.pointerId) return;
  selectRange(drag.original?.start ?? 0, drag.original?.end ?? dayMinutes);
  drag = undefined;
});
window.addEventListener('blur', () => { drag = undefined; });
startInput.addEventListener('change', () => {
  const start = Number(startInput.value);
  selectRange(start, Math.max(Number(endInput.value), start + interval));
});
endInput.addEventListener('change', () => {
  const end = Number(endInput.value);
  selectRange(Math.min(Number(startInput.value), end - interval), end);
});
$('full-day').addEventListener('click', () => selectRange(0, dayMinutes));

function updateStar(button) {
  const starred = state.stars.has(button.dataset.url);
  button.setAttribute('aria-pressed', starred);
  button.textContent = starred ? '★' : '☆';
  button.title = starred ? 'Unstar page' : 'Star page';
}

function starButton(visit) {
  const button = element('button', 'star');
  button.type = 'button';
  button.dataset.url = visit.url;
  button.setAttribute('aria-label', 'Star ' + visit.title);
  updateStar(button);
  button.addEventListener('click', async () => {
    button.disabled = true;
    const key = STAR_PREFIX + visit.url;
    try {
      if (state.stars.has(visit.url)) await chrome.storage.local.remove(key);
      else await chrome.storage.local.set({[key]: true});
    } catch {
      showNotice('Could not save that star. Try again.');
    } finally {
      button.disabled = false;
    }
  });
  return button;
}

function visitCopy(visit, showDomain = true) {
  const copy = element('div', 'visit-copy');
  const url = webUrl(visit.url);
  const title = element(url ? 'a' : 'span', 'visit-title', visit.title);
  title.title = visit.title;
  if (url) {
    title.href = url.href;
    title.target = '_blank';
    title.rel = 'noopener noreferrer';
  }
  copy.append(title);
  if (showDomain) {
    const domain = element('span', 'visit-domain', visit.domain);
    domain.title = visit.url;
    copy.append(domain);
  }
  return copy;
}

function visitTime(visit) {
  const time = element('time', 'visit-time', timeFormat.format(visit.time));
  time.dateTime = new Date(visit.time).toISOString();
  time.title = 'Visited ' + captureFormat.format(visit.time);
  return time;
}

function row(visit, single = false) {
  const node = element(single ? 'article' : 'li', single ? 'visit-row single' : 'visit-row');
  const copy = visitCopy(visit, single);
  const time = visitTime(visit);
  if (single) {
    node.dataset.category = visit.category;
    copy.append(element('span', 'visit-category', visit.category));
    node.append(copy, time);
  } else {
    node.append(time, copy);
  }
  node.append(starButton(visit));
  return node;
}

function cluster(group) {
  const first = group[0];
  const last = group.at(-1);
  const key = first.domain;
  const categories = [...new Set(group.map(visit => visit.category))].join(', ');
  const summary = element('summary');
  const time = visitTime(first);
  time.classList.add('cluster-time');
  if (first !== last) time.title = timeFormat.format(first.time) + ' – ' + timeFormat.format(last.time);
  const host = element('span', 'cluster-host');
  const name = element('span', 'host', first.domain);
  name.title = first.domain + ' · ' + categories;
  host.append(name, element('span', 'sr-only', categories));
  const chevron = element('span', 'cluster-chevron');
  chevron.setAttribute('aria-hidden', 'true');
  summary.append(time, host, element('span', 'cluster-count', visitsText(group.length)), chevron);
  const details = element('details');
  details.dataset.category = first.category;
  const list = element('div', 'cluster-visits');
  const populate = () => {
    if (!list.hasChildNodes()) {
      const timeline = element('ol', 'visit-timeline');
      for (const visit of group) timeline.append(row(visit));
      list.append(element('p', 'visit-category', categories), timeline);
    }
  };
  details.open = state.expanded.has(key);
  if (details.open) populate();
  details.append(summary, list);
  details.addEventListener('toggle', () => {
    if (!details.isConnected) return;
    if (details.open) {
      state.expanded.add(key);
      populate();
    } else state.expanded.delete(key);
  });
  return details;
}

function gridCard(visit) {
  const article = element('article', 'visit-card');
  let hash = 0;
  for (const character of visit.domain) hash = (hash * 31 + character.codePointAt(0)) >>> 0;
  const tile = element('div', 'preview tile-' + hash % 6);
  tile.setAttribute('aria-hidden', 'true');
  const monogram = visit.domain.replace(/^www\./, '').match(/[\p{L}\p{N}]/u)?.[0] ?? '·';
  const image = element('img');
  image.alt = '';
  image.hidden = true;
  tile.append(element('span', 'monogram', monogram.toLocaleUpperCase()), image);
  const label = element('span', 'preview-label', 'Generated preview');
  const content = element('div', 'card-content');
  const title = element('div', 'card-main');
  title.append(visitCopy(visit), starButton(visit));
  const meta = element('div', 'card-meta');
  meta.append(visitTime(visit), label);
  content.append(title, meta);
  article.append(tile, content);
  tracked.set(tile, {url: visit.url, image, label, visible: false, requested: false, ticket: 0});
  observer.observe(tile);
  return article;
}

function gridTimeline(visits) {
  const timeline = element('div', 'gallery-timeline');
  const midnight = localDay(state.date).start;
  const blockLength = interval * 60_000;
  let previousStart;
  let cards;
  for (const visit of visits) {
    const start = midnight + Math.floor((visit.time - midnight) / blockLength) * blockLength;
    if (start !== previousStart) {
      const slot = element('section', 'gallery-slot');
      const heading = element('h3', 'gallery-time');
      const clock = element('time', '', timeFormat.format(start));
      clock.dateTime = new Date(start).toISOString();
      heading.append(clock);
      cards = element('div', 'gallery');
      slot.append(heading, cards);
      timeline.append(slot);
      previousStart = start;
    }
    cards.append(gridCard(visit));
  }
  return timeline;
}

function panel(heading, description, retry = false) {
  const node = element('div', 'panel');
  node.append(element('h3', '', heading), element('p', '', description));
  if (retry) {
    const control = element('button', '', 'Try again');
    control.type = 'button';
    control.addEventListener('click', () => refreshHistory(true));
    node.append(control);
  }
  return node;
}

function renderResults() {
  const results = $('results');
  const categoryKey = $('category-key');
  observer.disconnect();
  updatePreviews(undefined, false);
  tracked.clear();
  results.replaceChildren();
  $('more').hidden = true;
  results.setAttribute('aria-busy', state.phase === 'loading');
  $('result-count').textContent = '';
  $('partial').hidden = true;
  categoryKey.hidden = true;
  $('results-title').textContent = state.view === 'grid' ? 'Visited pages' :
    (state.incomplete ? 'Browsing visits' : 'Browsing groups');
  if (state.phase === 'loading') {
    results.append(panel('Loading history…', 'Reading visits from Brave.'));
    return;
  }
  if (state.phase === 'error') {
    results.append(panel('History couldn’t be loaded', 'Brave didn’t return visits for this date. Try loading the day again.', true));
    return;
  }

  const visits = visibleVisits(state.visits, state.filters, state.stars);
  const groupsShown = state.view === 'clusters' && !state.incomplete;
  const groups = groupsShown ? groupVisits(visits) : [];
  $('result-count').textContent = state.incomplete
    ? 'Loaded visits · ' + countText(visits.length)
    : visitsText(visits.length) + (groupsShown && groups.length
      ? ' · ' + countText(groups.length) + (groups.length === 1 ? ' group' : ' groups') : '');
  if (state.incomplete) {
    $('partial').hidden = false;
    $('partial').textContent = (state.failures
      ? 'Brave couldn’t load some visits. '
      : 'Visual History loaded part of this busy day. ') + 'Visits are shown individually.';
  }
  if (!visits.length) {
    results.append(state.filters.search || state.filters.category || state.filters.starred || state.filters.range
      ? panel('No matching visits', 'Try a different search or change the filters.')
      : panel('No visits to show', 'Choose another date to browse more history.'));
    return;
  }

  categoryKey.hidden = state.view !== 'clusters';
  if (state.view === 'grid') {
    results.append(gridTimeline(visits.slice(0, state.limit)));
  } else if (groupsShown) {
    const list = element('div', 'cluster-list');
    for (const group of groups.slice(0, state.limit)) list.append(cluster(group));
    results.append(list);
  } else {
    const list = element('div', 'individual-list');
    for (const visit of visits.slice(0, state.limit)) list.append(row(visit, true));
    results.append(list);
  }
  const more = (groupsShown ? groups.length : visits.length) - state.limit;
  $('more').hidden = more <= 0;
  $('more').textContent = groupsShown ? 'Show more clusters' : 'Show more visits';
}

function restyleVisits() {
  for (const visit of state.visits) visit.category = classify(visit.url, state.rules);
}

async function refreshHistory(showLoading = false) {
  loading?.abort();
  const controller = new AbortController();
  loading = controller;
  if (showLoading) {
    state.phase = 'loading';
    dateHeading();
    updateTimeline();
    renderResults();
  }
  try {
    const data = await loadDay(chrome.history, localDay(state.date), controller.signal);
    if (controller.signal.aborted) return;
    state.visits = data.visits;
    state.incomplete = data.incomplete;
    state.failures = data.failures;
    state.phase = data.failures && !data.visits.length ? 'error' : 'ready';
    restyleVisits();
  } catch {
    if (controller.signal.aborted) return;
    state.phase = 'error';
  }
  updateTimeline();
  renderResults();
}

function queueRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    if (!document.hidden) refreshHistory();
  }, 250);
}

function changeDate(value) {
  const date = localDay(value);
  if (!date || value > dateKey()) {
    dateHeading();
    return;
  }
  state.date = value;
  state.expanded.clear();
  state.limit = dayStep;
  refreshHistory(true);
}

function shiftDay(offset) {
  const day = new Date(localDay(state.date).start);
  day.setDate(day.getDate() + offset);
  changeDate(dateKey(day));
}

function changeFilter(change) {
  Object.assign(state.filters, change);
  state.limit = dayStep;
  updateTimeline();
  renderResults();
}

function setView(view) {
  state.view = view;
  state.limit = dayStep;
  $('clusters').setAttribute('aria-pressed', view === 'clusters');
  $('grid').setAttribute('aria-pressed', view === 'grid');
  renderResults();
}

function updateCaptureControls() {
  const enabled = state.hasPermission && state.prefs?.enabled;
  $('enable').hidden = state.hasPermission;
  $('enable').disabled = !state.prefs;
  $('preview-state').hidden = !state.hasPermission;
  $('preview-state').textContent = enabled ? 'Automatic previews on' : 'Previews paused';
  $('preview-state').classList.toggle('paused', !enabled);
  $('capture-setting').textContent = enabled ? 'Pause previews' :
    (state.hasPermission ? 'Resume previews' : 'Enable automatic previews');
  $('capture-setting').disabled = !state.prefs;
}

async function syncSettings() {
  try {
    const [prefs, hasPermission] = await Promise.all([readSettings(), chrome.permissions.contains(ALL_SITES)]);
    if (JSON.stringify(prefs.rules) !== JSON.stringify(state.prefs?.rules)) {
      state.rules = ruleTable(prefs.rules);
      restyleVisits();
      updateTimeline();
      renderResults();
    }
    state.prefs = prefs;
    state.hasPermission = hasPermission;
    updateCaptureControls();
  } catch {
    showNotice('Settings couldn’t be loaded. Reopen Visual History to try again.');
  }
}

async function updateUsage() {
  try {
    const {count, bytes} = await request('cache-usage');
    const amount = new Intl.NumberFormat(undefined, {maximumFractionDigits: 1}).format(bytes / 1024);
    $('cache-usage').textContent = countText(count) + (count === 1 ? ' thumbnail' : ' thumbnails') +
      ' · ' + amount + ' KiB of 1 MiB';
  } catch {
    $('cache-usage').textContent = 'Thumbnail storage couldn’t be read.';
  }
}

async function toggleCapture(button) {
  button.disabled = true;
  const enable = !state.hasPermission || !state.prefs.enabled;
  try {
    if (enable && !state.hasPermission && !await chrome.permissions.request(ALL_SITES)) {
      showNotice('Permission declined. History and generated previews are available.');
      return;
    }
    await request('set-enabled', {enabled: enable});
    showNotice(enable ? 'Automatic previews are on.' : 'Automatic previews are paused.');
  } catch (error) {
    showNotice(error.message || 'Could not change automatic previews.');
  } finally {
    await syncSettings();
    button.disabled = !state.prefs;
  }
}

const ruleInputs = new Map();
const compactCategoryNames = {'Local Development': 'Local dev', 'AI Research': 'AI', 'Documentation': 'Docs'};
for (const category of CATEGORIES) {
  $('category').append(new Option(category, category));
  const keyItem = element('li');
  keyItem.dataset.category = category;
  keyItem.title = category;
  const label = element('span', '', compactCategoryNames[category] ?? category);
  label.setAttribute('aria-hidden', 'true');
  keyItem.append(label, element('span', 'sr-only', category));
  $('category-legend').append(keyItem);
  const row = element('tr');
  const name = element('th', '', category);
  name.scope = 'row';
  name.id = 'rule-' + ruleInputs.size;
  const input = element('textarea');
  input.rows = 2;
  input.maxLength = 3000;
  input.spellcheck = false;
  input.setAttribute('aria-labelledby', name.id);
  ruleInputs.set(category, input);
  const field = element('td');
  field.append(input);
  row.append(name, field);
  $('rule-table').append(row);
}

$('settings').addEventListener('click', () => {
  if (!state.prefs) {
    syncSettings();
    return;
  }
  $('settings-notice').textContent = '';
  $('rules-notice').textContent = '';
  $('exclusions').value = state.prefs.exclusions;
  for (const [category, input] of ruleInputs) input.value = state.prefs.rules[category];
  $('settings-dialog').showModal();
  updateUsage();
});
$('close-settings').addEventListener('click', () => $('settings-dialog').close());
$('enable').addEventListener('click', () => toggleCapture($('enable')));
$('capture-setting').addEventListener('click', () => toggleCapture($('capture-setting')));
$('clear-previews').addEventListener('click', async () => {
  $('clear-previews').disabled = true;
  try {
    await request('clear-previews');
    updatePreviews(undefined, false);
    showNotice('Thumbnails cleared.');
    await updateUsage();
  } catch (error) {
    showNotice(error.message || 'Could not clear thumbnails.');
  } finally {
    $('clear-previews').disabled = false;
  }
});
$('rules-form').addEventListener('submit', async event => {
  event.preventDefault();
  const exclusions = $('exclusions').value;
  const rules = Object.fromEntries([...ruleInputs].map(([category, input]) => [category, input.value]));
  $('save-rules').disabled = true;
  try {
    await request('save-rules', {rules, exclusions});
    await syncSettings();
    $('rules-notice').textContent = 'Settings saved.';
    updateUsage();
  } catch (error) {
    $('rules-notice').textContent = error.message || 'Could not save these settings.';
  } finally {
    $('save-rules').disabled = false;
  }
});

$('previous-day').addEventListener('click', () => shiftDay(-1));
$('next-day').addEventListener('click', () => shiftDay(1));
$('date').addEventListener('change', event => changeDate(event.target.value));
$('search').addEventListener('input', event => changeFilter({search: event.target.value}));
$('category').addEventListener('change', event => changeFilter({category: event.target.value}));
$('starred').addEventListener('click', () => {
  $('starred').setAttribute('aria-pressed', !state.filters.starred);
  changeFilter({starred: !state.filters.starred});
});
$('clusters').addEventListener('click', () => setView('clusters'));
$('grid').addEventListener('click', () => setView('grid'));
$('more').addEventListener('click', () => {
  state.limit += dayStep;
  renderResults();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (PREFERENCES in changes) syncSettings();
  let starChanged = false;
  for (const [key, change] of Object.entries(changes)) {
    if (!key.startsWith(STAR_PREFIX)) continue;
    const url = key.slice(STAR_PREFIX.length);
    if (change.newValue === true) state.stars.add(url);
    else state.stars.delete(url);
    starChanged = true;
  }
  if (!starChanged) return;
  if (state.filters.starred) {
    const wasInResults = $('results').contains(document.activeElement);
    changeFilter({});
    if (wasInResults) $('starred').focus();
  } else document.querySelectorAll('.star').forEach(updateStar);
});
chrome.permissions.onAdded.addListener(syncSettings);
chrome.permissions.onRemoved.addListener(syncSettings);
chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message.type === 'preview-settings-changed') {
    updatePreviews();
    syncSettings();
    if ($('settings-dialog').open) updateUsage();
  } else if (message.type === 'preview-saved') {
    updatePreviews(message.url);
    if ($('settings-dialog').open) updateUsage();
  }
});
chrome.history.onVisited.addListener(queueRefresh);
chrome.history.onVisitRemoved.addListener(() => {
  updatePreviews(undefined, false);
  refreshHistory(true);
});
document.addEventListener('visibilitychange', () => {
  updatePreviews(undefined, false);
  if (!document.hidden) queueRefresh();
});
window.addEventListener('focus', queueRefresh);

dateHeading();
updateTimeline();
renderResults();
(async () => {
  try {
    const settings = await chrome.storage.local.get(null);
    state.stars = new Set(Object.keys(settings).filter(key => key.startsWith(STAR_PREFIX) && settings[key] === true)
      .map(key => key.slice(STAR_PREFIX.length)));
  } catch {
    showNotice('Stars couldn’t be read from local storage.');
  }
  await syncSettings();
  refreshHistory();
})();

