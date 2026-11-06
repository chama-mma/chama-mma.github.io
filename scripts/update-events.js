/**
 * update-events.js
 * Reads upcoming UFC events from ufc.com/events and writes events.json
 * for the countdown bar on the CHAMA site.
 *
 * Run by the GitHub Action every 30 minutes. If ufc.com can't be reached,
 * the existing events.json is left as it is.
 */

const fs = require('fs');
const { JSDOM } = require('jsdom');

const SOURCE = 'https://www.ufc.com/events';
const OUTPUT = 'events.json';
const MAX_EVENTS = 8;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const clean = s => String(s || '').replace(/\s+/g, ' ').trim();

// "/event/ufc-334" → "UFC 334", "/event/ufc-fight-night-november-07-2026" → "UFC Fight Night"
function eventName(href) {
  const slug = (href.split('/event/')[1] || '').split(/[?#]/)[0].toLowerCase();
  let m = slug.match(/^ufc-(\d+)$/);
  if (m) return `UFC ${m[1]}`;
  if (slug.startsWith('ufc-fight-night')) return 'UFC Fight Night';
  // Anything else (special events): drop a trailing date, title-case the rest
  const words = slug
    .replace(/-(january|february|march|april|may|june|july|august|september|october|november|december)-\d{1,2}-\d{4}$/, '')
    .split('-').filter(Boolean);
  return words.map(w => (w === 'ufc' ? 'UFC' : w.charAt(0).toUpperCase() + w.slice(1))).join(' ') || 'UFC Event';
}

function toIso(ts) {
  const n = parseInt(ts, 10);
  return n > 0 ? new Date(n * 1000).toISOString() : null;
}

function parseEvents(html) {
  const doc = new JSDOM(html).window.document;
  const list = doc.querySelector('#events-list-upcoming') || doc;
  const events = [];

  for (const card of list.querySelectorAll('.c-card-event--result')) {
    const dateEl = card.querySelector('[data-main-card-timestamp]');
    const link = card.querySelector('.c-card-event--result__headline a') || card.querySelector('a[href*="/event/"]');
    if (!dateEl || !link) continue;

    const href = link.getAttribute('href') || '';
    const main = toIso(dateEl.getAttribute('data-main-card-timestamp'));
    if (!main) continue;

    const headline = clean(card.querySelector('.c-card-event--result__headline')?.textContent);
    const locality = clean(card.querySelector('.locality')?.textContent);
    const area = clean(card.querySelector('.administrative-area')?.textContent);
    const country = clean(card.querySelector('.country')?.textContent);

    events.push({
      name: eventName(href),
      main: /^tbd vs\.? tbd$/i.test(headline) ? '' : headline,     // page shows "Card TBA"
      start: main,                                                   // main card start
      prelims: toIso(dateEl.getAttribute('data-prelims-card-timestamp')),
      venue: clean(card.querySelector('.field--name-taxonomy-term-title')?.textContent),
      city: locality || area || country,
      country,
      url: new URL(href, SOURCE).toString()
    });
  }

  // De-duplicate and sort by start time
  const seen = new Set();
  return events
    .filter(e => !seen.has(e.url) && seen.add(e.url))
    .sort((a, b) => a.start.localeCompare(b.start))
    .slice(0, MAX_EVENTS);
}

async function main() {
  console.log(`Fetching ${SOURCE} ...`);
  const res = await fetch(SOURCE, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.9' },
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const events = parseEvents(await res.text());

  if (events.length === 0) {
    throw new Error('No events found — ufc.com page structure may have changed');
  }

  // Only write (and therefore commit) when the schedule actually changed
  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(OUTPUT, 'utf8')); } catch (e) {}
  if (previous && JSON.stringify(previous.events) === JSON.stringify(events)) {
    console.log(`No schedule changes (${events.length} events) — events.json left unchanged.`);
    return;
  }

  fs.writeFileSync(OUTPUT, JSON.stringify({
    updated: new Date().toISOString(),
    source: SOURCE,
    events
  }, null, 2));

  console.log(`Wrote ${OUTPUT} with ${events.length} events:`);
  events.forEach(e => console.log(`  ${e.start.slice(0, 16)}Z  ${e.name.padEnd(16)} ${e.main || 'Card TBA'} · ${e.city}`));
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Events update failed (keeping existing events.json):', err.message);
    process.exit(1);
  });
