import {
  ALL_SITES, CATEGORIES, PREFERENCES, normalizeHosts, parseHostList, previewAllowed, readSettings, ruleTable, webUrl
} from './rules.mjs';
import {
  MAX_AGE, cacheUsage, clearPreviews, compressPreview, readPreview, removeExcluded, savePreview
} from './previews.mjs';

const SETTLE_MS = 420;
const CAPTURE_GAP_MS = 760;
const DASHBOARD = chrome.runtime.getURL('dashboard.html');
let attempt;
let wakeTimer;
let due;
let lastCapture = -Infinity;
let cacheVersion = 0;
let purgeRequired = false;
let privacyWork = Promise.resolve();

function notify(type, url) {
  chrome.runtime.sendMessage({type, url}).catch(() => {});
}

function cancelCapture() {
  clearTimeout(wakeTimer);
  due = undefined;
  attempt?.abort();
}

function armCapture() {
  if (attempt || due === undefined) return;
  const wait = Math.max(due, lastCapture + CAPTURE_GAP_MS) - performance.now();
  wakeTimer = setTimeout(runCapture, Math.max(0, Math.ceil(wait)));
}

function scheduleCapture() {
  cancelCapture();
  due = performance.now() + SETTLE_MS;
  armCapture();
}

function changePrivacy(work) {
  cancelCapture();
  cacheVersion += 1;
  const changed = privacyWork.then(work);
  privacyWork = changed.catch(() => {});
  return changed.finally(() => notify('preview-settings-changed'));
}

async function ensurePurged() {
  if (purgeRequired) {
    await clearPreviews();
    purgeRequired = false;
  }
}

function eligibleWindow(window) {
  return window.focused && !window.incognito && window.state !== 'minimized' &&
    ['normal', 'popup'].includes(window.type);
}

async function checkedTab(signal, expected) {
  const [settings, allowed] = await Promise.all([readSettings(), chrome.permissions.contains(ALL_SITES)]);
  if (!settings.enabled || !allowed || signal.aborted) return null;
  const window = expected ? await chrome.windows.get(expected.windowId) : await chrome.windows.getLastFocused();
  if (!eligibleWindow(window)) return null;
  const tabs = await chrome.tabs.query({windowId: window.id, active: true});
  const tab = tabs[0];
  if (tabs.length !== 1 || !tab.active || tab.incognito || tab.discarded || tab.frozen || tab.pendingUrl ||
      tab.status !== 'complete' || (tab.splitViewId != null && tab.splitViewId !== -1) ||
      !previewAllowed(tab.url, parseHostList(settings.exclusions))) return null;
  const focused = await chrome.windows.get(window.id);
  if (!eligibleWindow(focused) || signal.aborted) return null;
  if (expected && (expected.tabId !== tab.id || expected.url !== tab.url)) return null;
  return {windowId: window.id, tabId: tab.id, url: tab.url};
}

function containsVisit(visits, visitId) {
  return visits.some(visit => visit.visitId === visitId && visit.isLocal !== false);
}

async function runCapture() {
  due = undefined;
  attempt = new AbortController();
  const {signal} = attempt;
  try {
    await privacyWork;
    await ensurePurged();
    const candidate = await checkedTab(signal);
    if (!candidate) return;
    const existing = await readPreview(candidate.url);
    const visits = await chrome.history.getVisits({url: candidate.url});
    if (existing && containsVisit(visits, existing.visitId)) return;

    let latest;
    for (const visit of visits) {
      if (visit.isLocal !== false && Number.isFinite(visit.visitTime) &&
          (!latest || visit.visitTime > latest.visitTime)) latest = visit;
    }
    if (!latest || !await checkedTab(signal, candidate)) return;
    lastCapture = performance.now();
    const screenshot = await chrome.tabs.captureVisibleTab(candidate.windowId, {format: 'jpeg', quality: 80});
    const capturedAt = Date.now();
    if (!await checkedTab(signal, candidate)) return;
    const blob = await compressPreview(screenshot, signal);
    if (!blob || !containsVisit(await chrome.history.getVisits({url: candidate.url}), latest.visitId)) return;
    if (!await checkedTab(signal, candidate)) return;
    const saved = await savePreview({url: candidate.url, visitId: latest.visitId, capturedAt, blob}, signal);
    if (saved && !signal.aborted) notify('preview-saved', candidate.url);
  } catch {
    // A closed tab, browser capture limit, or encode failure leaves the generated tile in place.
  } finally {
    attempt = undefined;
    armCapture();
  }
}

async function getPreview(url) {
  if (!webUrl(url)) return null;
  const version = cacheVersion;
  await privacyWork;
  await ensurePurged();
  if (version !== cacheVersion) return null;
  const prefs = await readSettings();
  if (!previewAllowed(url, parseHostList(prefs.exclusions))) return null;
  const record = await readPreview(url);
  if (!record || version !== cacheVersion) return null;
  const bytes = new Uint8Array(await record.blob.arrayBuffer());
  const visits = await chrome.history.getVisits({url});
  if (version !== cacheVersion || !containsVisit(visits, record.visitId) ||
      Date.now() - record.capturedAt >= MAX_AGE) return null;
  return {capturedAt: record.capturedAt, image: 'data:image/webp;base64,' + bytes.toBase64()};
}

function setEnabled(enabled) {
  return changePrivacy(async () => {
    if (enabled && !await chrome.permissions.contains(ALL_SITES)) {
      throw new Error('Brave has not granted the permission for automatic previews.');
    }
    const preferences = {...await readSettings(), enabled};
    await chrome.storage.local.set({[PREFERENCES]: preferences});
    if (enabled) scheduleCapture();
  });
}

function saveRules(message) {
  if (!message.rules || typeof message.rules !== 'object') throw new Error('Enter site names in the rule table.');
  const rules = Object.fromEntries(CATEGORIES.map(category => [category, normalizeHosts(message.rules[category])]));
  ruleTable(rules);
  const exclusions = normalizeHosts(message.exclusions);
  const excluded = parseHostList(exclusions);
  return changePrivacy(async () => {
    const preferences = {...await readSettings(), rules, exclusions};
    await removeExcluded(url => previewAllowed(url, excluded));
    await chrome.storage.local.set({[PREFERENCES]: preferences});
  });
}

async function dashboardRequest(message) {
  switch (message.type) {
    case 'get-preview':
      return getPreview(message.url);
    case 'cache-usage':
      await privacyWork;
      await ensurePurged();
      return cacheUsage();
    case 'set-enabled':
      if (typeof message.enabled !== 'boolean') throw new Error('Choose whether to enable previews.');
      return setEnabled(message.enabled);
    case 'clear-previews':
      purgeRequired = true;
      return changePrivacy(ensurePurged);
    case 'save-rules':
      return saveRules(message);
    default:
      throw new Error('Unknown dashboard request.');
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.url !== DASHBOARD || !message) return false;
  dashboardRequest(message).then(
    value => respond({ok: true, value}),
    error => respond({ok: false, error: error.message || 'Visual History could not complete the request.'})
  );
  return true;
});

chrome.action.onClicked.addListener(() => chrome.tabs.create({url: DASHBOARD}).catch(() => {}));
chrome.tabs.onActivated.addListener(scheduleCapture);
chrome.tabs.onUpdated.addListener((_id, change, tab) => {
  if (tab.active && ['status', 'url', 'discarded', 'frozen', 'splitViewId'].some(key => key in change)) {
    scheduleCapture();
  }
});
chrome.tabs.onReplaced.addListener(scheduleCapture);
chrome.tabs.onDetached.addListener(scheduleCapture);
chrome.tabs.onAttached.addListener(scheduleCapture);
chrome.windows.onFocusChanged.addListener(id => {
  if (id === chrome.windows.WINDOW_ID_NONE) cancelCapture();
  else scheduleCapture();
});
chrome.permissions.onAdded.addListener(scheduleCapture);
chrome.permissions.onRemoved.addListener(cancelCapture);
chrome.runtime.onStartup.addListener(scheduleCapture);
chrome.history.onVisitRemoved.addListener(() => {
  purgeRequired = true;
  changePrivacy(ensurePurged).catch(() => {});
});
