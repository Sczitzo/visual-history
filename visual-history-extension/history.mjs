import {parseUrl} from './rules.mjs';

const URL_PAGE_SIZE = 400;
const URL_LIMIT = 2400;
const VISIT_LIMIT = 8000;
const SEARCH_LIMIT = 63;
const QUERY_BATCH = 8;
const visitOrder = new Intl.Collator('en', {numeric: true});

export function dateKey(date = new Date()) {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return [year, month, day].join('-');
}

export function localDay(key) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
  const [year, month, day] = key.split('-').map(Number);
  if (year < 1) return null;
  const start = new Date(0);
  start.setFullYear(year, month - 1, day);
  start.setHours(0, 0, 0, 0);
  if (dateKey(start) !== key) return null;
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  end.setHours(0, 0, 0, 0);
  return {start: start.getTime(), end: end.getTime()};
}

async function readCandidates(history, range, signal) {
  const windows = [range];
  const urls = new Map();
  let saturated = false;
  let failures = 0;
  for (let searches = 0; windows.length && searches < SEARCH_LIMIT && urls.size <= URL_LIMIT; searches++) {
    signal?.throwIfAborted();
    const {start, end} = windows.pop();
    let items;
    try {
      items = await history.search({text: '', startTime: start, endTime: end, maxResults: URL_PAGE_SIZE + 1});
    } catch (error) {
      signal?.throwIfAborted();
      if (searches === 0) throw error;
      failures += 1;
      continue;
    }
    for (const item of items) {
      if (!urls.has(item.url)) urls.set(item.url, item);
    }
    if (items.length <= URL_PAGE_SIZE) continue;
    const middle = start + Math.floor((end - start) / 2);
    if (middle === start) saturated = true;
    // Search the newer half next, so a partial day starts with recent results.
    else windows.push({start, end: middle}, {start: middle, end});
  }
  return {
    candidates: [...urls.values()].slice(0, URL_LIMIT),
    incomplete: saturated || failures > 0 || windows.length > 0 || urls.size > URL_LIMIT,
    failures
  };
}

export async function loadDay(history, range, signal) {
  let {candidates, incomplete, failures} = await readCandidates(history, range, signal);
  const visits = [];
  const seen = new Set();
  // shortcut: Brave returns every visit for a candidate URL, use a ranged visit API if one becomes available.
  batches: for (let offset = 0; offset < candidates.length; offset += QUERY_BATCH) {
    signal?.throwIfAborted();
    const batch = candidates.slice(offset, offset + QUERY_BATCH);
    const reads = await Promise.allSettled(batch.map(async item => history.getVisits({url: item.url})));
    for (const [index, read] of reads.entries()) {
      const item = batch[index];
      if (read.status === 'rejected') {
        incomplete = true;
        failures += 1;
        continue;
      }
      const parsed = parseUrl(item.url);
      const host = parsed?.host || '';
      const domain = ['http:', 'https:'].includes(parsed?.protocol) ? host :
        (parsed?.protocol === 'file:' ? 'Local file' : 'Browser page');
      for (const visit of read.value) {
        const time = visit.visitTime;
        if (!Number.isFinite(time) || typeof visit.visitId !== 'string') {
          incomplete = true;
          continue;
        }
        if (time < range.start || time >= range.end || seen.has(visit.visitId)) continue;
        if (visits.length === VISIT_LIMIT) {
          incomplete = true;
          break batches;
        }
        seen.add(visit.visitId);
        visits.push({visitId: visit.visitId, url: item.url, title: item.title?.trim() || domain, host, domain, time});
      }
    }
  }
  signal?.throwIfAborted();
  visits.sort((a, b) => b.time - a.time || visitOrder.compare(b.visitId, a.visitId));
  return {visits, incomplete, failures};
}

export function groupVisits(visits) {
  const sites = new Map();
  for (const visit of visits.slice().reverse()) {
    const group = sites.get(visit.domain);
    if (group) group.push(visit);
    else sites.set(visit.domain, [visit]);
  }
  return [...sites.values()];
}

export function localMinute(timestamp) {
  const time = new Date(timestamp);
  return time.getHours() * 60 + time.getMinutes();
}

export function visibleVisits(visits, filters, stars) {
  const search = filters.search.trim().toLocaleLowerCase();
  const {range} = filters;
  return visits.filter(visit => {
    if (range) {
      const minute = localMinute(visit.time);
      if (minute < range.start || minute >= range.end) return false;
    }
    return (!search || [visit.title, visit.url, visit.category].some(value => value.toLocaleLowerCase().includes(search))) &&
      (!filters.category || filters.category === visit.category) &&
      (!filters.starred || stars.has(visit.url));
  });
}
