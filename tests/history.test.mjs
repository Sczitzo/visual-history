import assert from 'node:assert/strict';
import test from 'node:test';
import {classify, parseHostList, previewAllowed, ruleTable, webUrl} from '../visual-history-extension/rules.mjs';
import {groupVisits, loadDay, localDay, visibleVisits} from '../visual-history-extension/history.mjs';

test('each displayed site has one group spanning the day, ordered by its first visit', () => {
  const start = new Date(2026, 10, 18, 12).getTime();
  const visits = [
    ['7', 'localhost:3000', 0], ['6', 'localhost:3000', 30],
    ['5', 'localhost:4000', 31], ['4', 'localhost:3000', 32],
    ['3', 'localhost:3000', 63], ['2', 'example.test', 65], ['1', 'localhost:3000', 66]
  ].map(([visitId, domain, minutes]) => ({visitId, domain, time:start - minutes * 60000}));
  assert.deepEqual(groupVisits(visits).map(group => group.map(v => v.visitId)), [
    ['1', '3', '4', '6', '7'], ['2'], ['5']
  ]);
});

test('a complete day counts repeat visits, uses local bounds, and excludes next midnight', async () => {
  const range = localDay('2026-11-18');
  assert.equal(new Date(range.start).getHours(), 0);
  const url = 'https://example.test/report?a=2#notes';
  const result = await loadDay({
    search: async query => {
      assert.equal(query.startTime, range.start);
      assert.equal(query.endTime, range.end);
      assert.ok(query.maxResults <= 500);
      return [{url, title:'Report'}];
    },
    getVisits: async ({url: requested}) => {
      assert.equal(requested, url);
      return [
        {visitId:'1', visitTime:range.start - 1},
        {visitId:'2', visitTime:range.start},
        {visitId:'3', visitTime:range.start + 3600000},
        {visitId:'4', visitTime:range.end}
      ];
    }
  }, range);
  assert.equal(result.incomplete, false);
  assert.deepEqual(result.visits.map(v => v.visitId), ['3','2']);
  assert.deepEqual(result.visits.map(v => v.url), [url,url]);
  assert.equal(localDay('2026-02-30'), null);
});

test('a busy day reads both time windows and looks up a repeated URL once', async () => {
  const range = localDay('2026-11-18');
  const middle = range.start + (range.end - range.start) / 2;
  const pages = new Map(Array.from({length:420}, (_, index) => [
    'https://example.test/' + index,
    [{visitId:String(index + 1), visitTime:index < 210 ? range.start + index : middle + index - 210}]
  ]));
  const repeated = 'https://example.test/repeat';
  pages.set(repeated, [
    {visitId:'421', visitTime:middle - 1},
    {visitId:'422', visitTime:middle}
  ]);
  const windows = [];
  const lookups = new Set();
  const result = await loadDay({
    search: async ({startTime, endTime, maxResults}) => {
      windows.push([startTime, endTime]);
      const matches = [];
      for (const [url, visits] of pages) {
        const last = visits.filter(visit => visit.visitTime >= startTime && visit.visitTime < endTime).at(-1);
        if (last) matches.push({url, lastVisitTime:last.visitTime});
      }
      return matches.sort((a, b) => b.lastVisitTime - a.lastVisitTime).slice(0, maxResults);
    },
    getVisits: async ({url}) => {
      assert.equal(lookups.has(url), false);
      lookups.add(url);
      return pages.get(url);
    }
  }, range);
  assert.deepEqual(windows, [[range.start, range.end], [middle, range.end], [range.start, middle]]);
  assert.equal(lookups.size, pages.size);
  assert.equal(result.incomplete, false);
  assert.equal(result.visits.length, 422);
  assert.equal(result.visits.filter(visit => visit.url === repeated).length, 2);
});

test('a saturated millisecond and a failed visit read both mark the day incomplete', async () => {
  const range = localDay('2026-11-18');
  const stamp = range.start + 3600000;
  let searches = 0;
  let calls = 0;
  const history = {
    search: async ({startTime, endTime, maxResults}) => {
      searches += 1;
      if (stamp < startTime || stamp >= endTime) return [];
      return Array.from({length:maxResults}, (_, i) => ({url:'https://example.test/'+i}));
    },
    getVisits: async () => [{visitId:String(++calls), visitTime:stamp}]
  };
  const bounded = await loadDay(history, range);
  assert.equal(calls, 401);
  assert.ok(searches > 1 && searches <= 63);
  assert.equal(bounded.incomplete, true);
  const failed = await loadDay({
    search: async () => [{url:'https://example.test/one'}, {url:'https://unavailable.test/'}],
    getVisits: async ({url}) => {
      if (url.includes('unavailable')) throw Error('History temporarily unavailable');
      return [{visitId:'1', visitTime:range.start}];
    }
  }, range);
  assert.equal(failed.incomplete, true);
  assert.equal(failed.failures, 1);
  assert.equal(failed.visits.length, 1);
});

test('a time range includes its start, excludes its end, and combines with the other filters', () => {
  const noon = new Date(2026, 10, 18, 12).getTime();
  const at = (minute, milliseconds = 0) => noon + minute * 60_000 + milliseconds;
  const guide = {url:'https://docs.test/handbook', title:'Guide', category:'Documentation'};
  const local = {url:'http://localhost:5512/guide', title:'Guide', category:'Local Development', time:at(15)};
  const visits = [
    {...guide, time:at(15)},
    {...guide, time:at(29, 59_999)},
    {...guide, time:at(14, 59_999)},
    {...guide, time:at(30)},
    {...guide, url:'https://docs.test/setup', time:at(15)},
    local
  ];
  const starred = new Set([guide.url, local.url]);
  const range = {start:12 * 60 + 15, end:12 * 60 + 30};
  assert.deepEqual(visibleVisits(visits, {search:' guide ', category:'Documentation', starred:true, range}, starred), visits.slice(0, 2));
  assert.deepEqual(visibleVisits(visits, {search:'handbook', category:'', starred:true, range:null}, starred), visits.slice(0, 4));
});

test('URL eligibility recognizes sensitive routes, disallows nonweb URLs, and applies domain and port exclusions', () => {
  const exclusions = parseHostList('example.test\nlocalhost:4555\n[::1]:8000');
  for (const candidate of [
    'https://mail.google.com/u/0', 'https://x.test/%73ign-in', 'https://x.test/#/checkout',
    'https://x.test/?redirect=%2Fbilling', 'https://chase.com/info', 'https://x.test/?access_token=secret',
    'https://sub.example.test./', 'http://localhost:4555/p', 'http://[::1]:8000/',
    'file:///C:/sample.html', 'brave://history/', 'https://name@x.test/', 'javascript:alert(1)'
  ]) assert.equal(previewAllowed(candidate, exclusions), false, candidate);
  for (const candidate of [
    'https://notexample.test/', 'http://localhost:4556/p', 'http://[::1]:8001/', 'https://x.test/articles'
  ]) assert.equal(previewAllowed(candidate, exclusions), true, candidate);
  assert.equal(webUrl('data:text/html,some-text'), null);
});

test('category rules reject malformed input and let a specific Other rule override a broader match', () => {
  const rules = ruleTable({
    'Local Development':'localhost',
    'AI Research':'research.example.test',
    'Media':'localhost:4555',
    'Documentation':'example.test',
    'Other':'internal.example.test'
  });
  assert.equal(classify('https://guide.example.test/',rules), 'Documentation');
  assert.equal(classify('https://research.example.test/',rules), 'AI Research');
  assert.equal(classify('https://internal.example.test/',rules), 'Other');
  assert.equal(classify('http://localhost:4555/',rules), 'Media');
  assert.equal(classify('http://localhost:4556/',rules), 'Local Development');
  assert.throws(() => parseHostList('https://example.test/path'), /site names/i);
  assert.throws(() => ruleTable({'Documentation':'example.test', 'Other':'example.test'}), /more than one/i);
});

