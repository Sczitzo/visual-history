export const ALL_SITES = {origins: ['<all_urls>']};
export const PREFERENCES = 'preferences';
export const STAR_PREFIX = 'star:';
export const DEFAULT_RULES = {
  'Local Development': 'localhost\n127.0.0.1\n[::1]',
  'AI Research': 'arxiv.org\nopenai.com\nchatgpt.com\nanthropic.com\nhuggingface.co\ngemini.google.com',
  'Media': 'youtube.com\nyoutu.be\nnetflix.com\nspotify.com\ntwitch.tv\nvimeo.com',
  'Documentation': 'developer.chrome.com\ndeveloper.mozilla.org\nlearn.microsoft.com\ndocs.python.org\nreadthedocs.io\nstackoverflow.com',
  'Other': ''
};
export const CATEGORIES = Object.keys(DEFAULT_RULES);
const DEFAULT_SETTINGS = {enabled: false, exclusions: '', rules: DEFAULT_RULES};
const SENSITIVE_DOMAINS = [
  'paypal.com', 'venmo.com', 'cash.app', 'stripe.com', 'wise.com', 'zellepay.com', 'squareup.com',
  'bankofamerica.com', 'chase.com', 'wellsfargo.com', 'citi.com', 'citibank.com', 'capitalone.com',
  'americanexpress.com', 'discover.com', 'usbank.com', 'td.com', 'schwab.com', 'fidelity.com',
  'vanguard.com', 'robinhood.com', 'coinbase.com', 'mail.google.com', 'outlook.live.com',
  'outlook.office.com', 'mail.yahoo.com', 'proton.me', '1password.com', 'bitwarden.com',
  'irs.gov', 'ssa.gov', 'healthcare.gov'
];
const SENSITIVE_TERM = /(?:^|[^a-z0-9])(?:log[\s_-]?in|logon|sign[\s_-]?(?:in|up)|auth(?:entication|enticate|orize|orization)?|oauth2?|saml|sso|mfa|2fa|passkeys?|passwords?|(?:access|refresh|id)[_-]?token|reset[\s_-]?password|accounts?|wallets?|payments?|pay|checkout|billing|banks?|banking|webmail|patient|mychart)(?=$|[^a-z0-9])/i;

export function parseUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function webUrl(value) {
  const url = parseUrl(value);
  return url && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url : null;
}

export function parseHostList(text) {
  if (typeof text !== 'string' || text.length > 3000) {
    throw new Error('Keep each site list under 3,000 characters.');
  }
  const rules = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = /^(\[[a-f0-9:.]+\]|[^:/\s\\?#@*%]+)(?::(\d{1,5}))?$/i.exec(line);
    const url = parts && parseUrl('https://' + line);
    const host = url?.hostname.replace(/\.+$/, '');
    if (!host || !/^(?:[a-z0-9_-]+(?:\.[a-z0-9_-]+)*|\[[a-f0-9:.]+\])$/.test(host)) {
      throw new Error('Enter site names such as example.com or localhost:3000, one per line.');
    }
    const port = parts[2] ? String(Number(parts[2])) : '';
    rules.set(port ? host + ':' + port : host, {host, port});
  }
  return [...rules.values()];
}

export function normalizeHosts(text) {
  return parseHostList(text).map(({host, port}) => port ? host + ':' + port : host).join('\n');
}

function hostMatches(hostname, rule) {
  return hostname === rule || hostname.endsWith('.' + rule);
}

function siteMatches(url, rule) {
  const hostname = url.hostname.replace(/\.+$/, '');
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return hostMatches(hostname, rule.host) && (!rule.port || port === rule.port);
}

export function previewAllowed(rawUrl, exclusions) {
  const url = webUrl(rawUrl);
  if (!url || exclusions.some(rule => siteMatches(url, rule))) return false;
  const hostname = url.hostname.replace(/\.+$/, '');
  if (SENSITIVE_DOMAINS.some(domain => hostMatches(hostname, domain))) return false;
  const route = hostname + url.pathname + url.search + url.hash;
  try {
    const decoded = decodeURIComponent(route);
    const twiceDecoded = /%[0-9a-f]{2}/i.test(decoded) ? decodeURIComponent(decoded) : decoded;
    const separated = twiceDecoded.replace(/([a-z])([A-Z])/g, '$1-$2');
    return !SENSITIVE_TERM.test(separated);
  } catch {
    return false;
  }
}

export function ruleTable(values) {
  const seen = new Set();
  return CATEGORIES.flatMap(category => parseHostList(values[category] ?? '').map(rule => {
    const key = rule.host + ':' + rule.port;
    if (seen.has(key)) throw new Error('A site rule appears in more than one category.');
    seen.add(key);
    return {...rule, category};
  }));
}

export function classify(rawUrl, rules) {
  const url = webUrl(rawUrl);
  if (!url) return 'Other';
  let best;
  let specificity = 0;
  for (const rule of rules) {
    const score = rule.host.length * 2 + Number(Boolean(rule.port));
    if (score > specificity && siteMatches(url, rule)) {
      best = rule;
      specificity = score;
    }
  }
  return best?.category ?? 'Other';
}

export async function readSettings(storage = chrome.storage.local) {
  const {preferences = DEFAULT_SETTINGS} = await storage.get(PREFERENCES);
  return preferences;
}
