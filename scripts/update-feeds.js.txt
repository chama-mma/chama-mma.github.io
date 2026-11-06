const Parser = require('rss-parser');
const fs = require('fs');

const OUTPUT = 'feeds.json';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const parser = new Parser({
  timeout: 10000,
  customFields: {
    item: [
      ['media:content', 'mediaContent', { keepArray: true }],
      ['media:thumbnail', 'mediaThumbnail', { keepArray: true }],
      ['content:encoded', 'contentEncoded'],
      ['description', 'description']
    ]
  },
  headers: {
    'User-Agent': UA,
    'Accept': 'application/rss+xml, application/xml, text/xml, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.google.com/',
    'Cache-Control': 'no-cache'
  }
});

const FEEDS = [
  { id: 'bloodyelbow', name: 'Bloody Elbow', url: 'https://bloodyelbow.com/feed/',               site: 'https://bloodyelbow.com/',     limit: 6 },
  { id: 'mmafighting', name: 'MMA Fighting', url: 'https://www.mmafighting.com/rss/current.xml', site: 'https://www.mmafighting.com/', limit: 6 },
  { id: 'sherdog',     name: 'Sherdog',      url: 'https://www.sherdog.com/rss/news.xml',        site: 'https://www.sherdog.com/',     limit: 6 }
];

/* ---------- Helpers ---------- */

// Hard timeout wrapper so one slow request can never hang the job
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms))
  ]);
}

// Feed titles often arrive HTML-encoded (don&#8217;t, &#36;1 million, &amp;) — decode them once here
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', eacute: 'é', aacute: 'á', oacute: 'ó', uacute: 'ú', iacute: 'í', ntilde: 'ñ' };
function decodeEntities(str) {
  let s = String(str || '');
  for (let i = 0; i < 2 && /&[#a-z0-9]+;/i.test(s); i++) {   // twice handles double-encoding (&amp;#8217;)
    s = s
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
      .replace(/&([a-z]+);/gi, (m, n) => NAMED[n.toLowerCase()] ?? m);
  }
  return s.replace(/\s+/g, ' ').trim();
}

function absoluteUrl(src, base) {
  try { return new URL(src, base).toString(); } catch (e) { return null; }
}

function extractImage(item) {
  if (item.enclosure?.url && /\.(jpg|jpeg|png|webp|gif)/i.test(item.enclosure.url)) {
    return item.enclosure.url;
  }
  for (const key of ['mediaContent', 'mediaThumbnail']) {
    const arr = [].concat(item[key] || []);
    for (const m of arr) {
      const url = m?.$?.url || m?.url;
      if (url && (key === 'mediaThumbnail' || /\.(jpg|jpeg|png|webp|gif)/i.test(url))) return url;
    }
  }
  const htmlSources = [
    item.contentEncoded, item['content:encoded'], item.content, item.description, item.summary
  ].filter(Boolean);
  for (const html of htmlSources) {
    const match = String(html).match(/<img[^>]+src=["']([^"']+)["']/i);
    if (match && match[1]) {
      const src = decodeEntities(match[1]);
      if (src && !/pixel|1x1|spacer|blank|logo-small/i.test(src)) return src;
    }
  }
  return null;
}

// Fallback for feeds without images (e.g. Sherdog): read the article's og:image / twitter:image
async function fetchArticleImage(link) {
  try {
    const res = await withTimeout(fetch(link, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.9' },
      redirect: 'follow'
    }), 8000);
    if (!res.ok) return null;
    // Only the <head> is needed; stop reading after ~150 KB
    const html = (await res.text()).slice(0, 150000);
    const patterns = [
      /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]*content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:image["']/i,
      /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]*content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]*name=["']twitter:image["']/i
    ];
    for (const re of patterns) {
      const m = html.match(re);
      if (m && m[1]) {
        const url = absoluteUrl(decodeEntities(m[1]), link);
        if (url && !/logo|default|placeholder/i.test(url)) return url;
      }
    }
  } catch (e) {
    console.log(`    (no image for ${link}: ${e.message})`);
  }
  return null;
}

/* ---------- Main ---------- */

// Previous output, so unchanged items keep their image without being re-fetched
function loadPrevious() {
  try { return JSON.parse(fs.readFileSync(OUTPUT, 'utf8')); } catch (e) { return null; }
}

async function fetchFeed(cfg, previous) {
  const prevImages = new Map();
  const prevSource = previous?.sources?.find(s => s.id === cfg.id);
  (prevSource?.items || []).forEach(i => i.image && prevImages.set(i.link, i.image));

  try {
    console.log(`Fetching ${cfg.name}...`);
    const feed = await withTimeout(parser.parseURL(cfg.url), 12000);

    const items = (feed.items || []).slice(0, cfg.limit).map(item => {
      const published = item.isoDate || item.pubDate;
      const date = published && !isNaN(Date.parse(published)) ? new Date(published).toISOString() : null;
      const link = item.link || item.guid || '#';
      return {
        title: decodeEntities(item.title) || 'Untitled',
        link,
        date,                                   // the page turns this into "2h ago" live
        image: extractImage(item) || prevImages.get(link) || null
      };
    });

    // Fill in missing images from the article pages (a few at a time)
    const missing = items.filter(i => !i.image && /^https?:/.test(i.link));
    for (let i = 0; i < missing.length; i += 3) {
      await Promise.all(missing.slice(i, i + 3).map(async it => { it.image = await fetchArticleImage(it.link); }));
    }

    console.log(`  → ${items.length} items (${items.filter(i => i.image).length} with images)`);
    return { id: cfg.id, name: cfg.name, site: cfg.site, items };
  } catch (err) {
    console.error(`  ✗ Failed ${cfg.name}: ${err.message}`);
    // Keep the last good stories instead of showing an empty column
    if (prevSource?.items?.length) {
      console.log(`  → keeping ${prevSource.items.length} items from the previous run`);
      return { id: cfg.id, name: cfg.name, site: cfg.site, items: prevSource.items, stale: true };
    }
    return { id: cfg.id, name: cfg.name, site: cfg.site, items: [], error: err.message };
  }
}

async function main() {
  const previous = loadPrevious();
  const sources = await Promise.all(FEEDS.map(cfg => fetchFeed(cfg, previous)));

  // Only write (and therefore commit + redeploy) when the stories actually changed
  const strip = list => JSON.stringify((list || []).map(s => ({ id: s.id, items: s.items })));
  if (previous && strip(previous.sources) === strip(sources)) {
    console.log('\nNo new stories — feeds.json left unchanged.');
    return;
  }

  fs.writeFileSync(OUTPUT, JSON.stringify({ generatedAt: new Date().toISOString(), sources }, null, 2));
  console.log('\nfeeds.json written');
  sources.forEach(s => console.log(`${s.name.padEnd(14)} ${s.error ? 'ERROR: ' + s.error : s.items.length + ' items'}${s.stale ? ' (stale)' : ''}`));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
