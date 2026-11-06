#!/usr/bin/env node
/**
 * Finds companies the board does not know yet and adds the ones hiring
 * creatives in Europe to companies.txt. Runs once a week in GitHub Actions.
 *
 * Every company on a hiring tool has a public jobs page at a predictable
 * address - jobs.ashbyhq.com/<company>, <company>.jobs.personio.de. Common
 * Crawl, a free public archive of the web, can list every such address it
 * has seen. Each new company's feed is then read once, and a company is
 * kept only if it has a creative role open in Europe right now.
 *
 * Local:  node discover.js            (NODE_USE_ENV_PROXY=1 behind a proxy)
 */

const fs = require('fs');
const { ATS, fetchFeed, pool, discipline, country, workplace, inEurope } = require('./fetch-jobs.js');

/* Where each tool's job pages live, and how the company's board name sits
   in the address. */
const SOURCES = [
  { ats: 'ashby',           url: 'jobs.ashbyhq.com/*',          slug: /^https?:\/\/jobs\.ashbyhq\.com\/([^/?#]+)/i },
  { ats: 'lever',           url: 'jobs.lever.co/*',             slug: /^https?:\/\/jobs\.lever\.co\/([^/?#]+)/i },
  { ats: 'greenhouse',      url: 'boards.greenhouse.io/*',      slug: /^https?:\/\/boards\.greenhouse\.io\/([^/?#]+)/i },
  { ats: 'greenhouse',      url: 'job-boards.greenhouse.io/*',  slug: /^https?:\/\/job-boards\.greenhouse\.io\/([^/?#]+)/i },
  { ats: 'personio',        url: '*.jobs.personio.de',          slug: /^https?:\/\/([a-z0-9-]+)\.jobs\.personio\.de/i },
  { ats: 'recruitee',       url: '*.recruitee.com',             slug: /^https?:\/\/([a-z0-9-]+)\.recruitee\.com/i },
  { ats: 'workable',        url: 'apply.workable.com/*',        slug: /^https?:\/\/apply\.workable\.com\/([^/?#]+)/i },
  { ats: 'smartrecruiters', url: 'jobs.smartrecruiters.com/*',  slug: /^https?:\/\/jobs\.smartrecruiters\.com\/([^/?#]+)/i },
];

/* Path segments that are the tool's own pages, not a company. */
const NOT_A_BOARD = /^(embed|api|j|jobs|v\d|www|app|help|support|static|assets|careers|login|oauth|sitemap.*|robots\.txt|favicon\.ico|_next|cdn-cgi|search|privacy|terms)$/i;

/* Two crawls are about two months of the web - plenty, and a company that
   only shows up further back has probably moved on. */
const CRAWLS = 2;
/* The index is a free service run on goodwill: one request at a time, a
   pause between them, and a cap on how much is read per tool. */
const MAX_PAGES = 40;
const PAUSE_MS = 1500;
/* A company checked and passed over is looked at again after this long. */
const RECHECK_DAYS = 90;

const INDEX = 'https://index.commoncrawl.org';
const wait = ms => new Promise(r => setTimeout(r, ms));

async function getIndex(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
      if (res.ok) return await res.text();
      /* 503 is the index asking callers to slow down. */
      if (res.status !== 503 && res.status !== 504) return null;
    } catch {}
    await wait(PAUSE_MS * 2 ** (i + 2));
  }
  return null;
}

async function slugsFromCrawl(crawl, source) {
  const base = `${INDEX}/${crawl}-index?url=${encodeURIComponent(source.url)}&output=json&fl=url`;
  const info = await getIndex(base + '&showNumPages=true');
  let pages = 0;
  try { pages = JSON.parse(info).pages; } catch {}
  const slugs = new Set();
  for (let p = 0; p < Math.min(pages, MAX_PAGES); p++) {
    await wait(PAUSE_MS);
    const body = await getIndex(`${base}&page=${p}`);
    for (const line of (body || '').split('\n')) {
      let url;
      try { url = JSON.parse(line).url; } catch { continue; }
      const m = url && url.match(source.slug);
      if (m) {
        const slug = decodeURIComponent(m[1]).toLowerCase();
        if (!NOT_A_BOARD.test(slug) && /^[\w.-]{2,60}$/.test(slug)) slugs.add(slug);
      }
    }
  }
  console.log(`  ${crawl} ${source.url.padEnd(28)} ${String(Math.min(pages, MAX_PAGES)).padStart(3)}/${pages} pages, ${slugs.size} boards`);
  return slugs;
}

/* A board's feed rarely says whose it is, so the name comes from the feed
   where it can and from the board name otherwise: acme-studio -> Acme Studio. */
async function companyName(slug, ats) {
  try {
    if (ats === 'greenhouse') {
      const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${slug}`,
        { signal: AbortSignal.timeout(20000) });
      if (res.ok) { const d = await res.json(); if (d.name) return d.name.trim(); }
    }
    if (ats === 'workable') {
      const res = await fetch(ATS.workable.url(slug), { signal: AbortSignal.timeout(20000) });
      if (res.ok) { const d = await res.json(); if (d.name) return d.name.trim(); }
    }
    if (ats === 'smartrecruiters') {
      const res = await fetch(ATS.smartrecruiters.url(slug), { signal: AbortSignal.timeout(20000) });
      const d = res.ok && await res.json();
      const name = d && ATS.smartrecruiters.owner(d);
      if (name) return name.trim();
    }
  } catch {}
  return slug.replace(/[-_.]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();
}

/* Does this board have a creative role in Europe open now? Age is not
   checked: a role posted two months ago still says the company hires
   designers here, and the daily run decides what is fresh enough to show. */
function creativeInEurope(rows) {
  return rows.filter(r => {
    if (!discipline(r.title)) return false;
    const loc = (r.location || 'Not stated').trim();
    return inEurope(country(loc), loc, workplace(r.work, loc));
  });
}

(async () => {
  if (typeof fetch !== 'function') {
    console.error('Needs Node 18+.'); process.exit(1);
  }
  const today = new Date().toISOString().slice(0, 10);

  /* Everything already on the list, by board and by name. */
  const txtPath = `${__dirname}/companies.txt`;
  const txt = fs.readFileSync(txtPath, 'utf8');
  let known = {};
  try { known = JSON.parse(fs.readFileSync(`${__dirname}/companies.json`, 'utf8')); } catch {}
  const haveBoard = new Set(Object.values(known).map(k => `${k.ats}:${String(k.slug).toLowerCase()}`));
  const haveName = new Set();
  /* Companies on the list whose board was never found - their line gets
     the board filled in rather than a second line. */
  const unmatched = new Map();
  const lines = txt.replace(/\n*$/, '').split('\n');
  lines.forEach((line, i) => {
    const [name, slug, ats] = line.replace(/^#\s*/, '').split('|').map(p => p.trim());
    if (name) haveName.add(name.toLowerCase());
    if (slug && ats) haveBoard.add(`${ats}:${slug.toLowerCase()}`);
    if (name && !slug && !line.startsWith('#') && !known[name]) unmatched.set(name.toLowerCase(), i);
  });

  /* Boards looked at before and passed over, so a weekly run only reads
     what is new to it. */
  const seenPath = `${__dirname}/discovered.json`;
  let seen = {};
  try { seen = JSON.parse(fs.readFileSync(seenPath, 'utf8')); } catch {}
  const fresh = d => Date.now() - Date.parse(d) < RECHECK_DAYS * 864e5;

  const list = await getIndex(`${INDEX}/collinfo.json`);
  let crawls = [];
  try { crawls = JSON.parse(list).slice(0, CRAWLS).map(c => c.id); } catch {}
  if (!crawls.length) { console.error('Common Crawl index unavailable; try again later.'); process.exit(1); }

  console.log(`Reading ${crawls.join(', ')}`);
  const candidates = new Map();
  for (const source of SOURCES)
    for (const crawl of crawls)
      for (const slug of await slugsFromCrawl(crawl, source)) {
        const key = `${source.ats}:${slug}`;
        if (!haveBoard.has(key) && !(seen[key] && fresh(seen[key])))
          candidates.set(key, { ats: source.ats, slug });
      }
  console.log(`\n${candidates.size} boards not yet checked`);

  /* Workable turns callers away when asked too fast, so it is read slowly
     and the rest at a normal pace. */
  const all = [...candidates.values()];
  const check = c => fetchFeed(c.slug, c.ats).then(f => ({ ...c, feed: f }));
  const results = [
    ...await pool(all.filter(c => c.ats !== 'workable'), 10, check),
    ...await pool(all.filter(c => c.ats === 'workable'), 2, check),
  ];

  const found = [];
  for (const r of results) {
    seen[`${r.ats}:${r.slug}`] = today;
    if (!r.feed) continue;
    const roles = creativeInEurope(r.feed.rows);
    if (roles.length) found.push({ ...r, roles });
  }

  const added = [], matched = [];
  for (const f of await pool(found, 10, async f => ({ ...f, name: await companyName(f.slug, f.ats) }))) {
    const key = f.name.toLowerCase();
    if (unmatched.has(key)) {
      lines[unmatched.get(key)] = `${lines[unmatched.get(key)].trim()} | ${f.slug} | ${f.ats}`;
      unmatched.delete(key);
      matched.push(f);
    } else if (!haveName.has(key)) {
      haveName.add(key);
      added.push(f);
    }
  }
  added.sort((a, b) => a.name.localeCompare(b.name));

  if (added.length || matched.length) {
    if (added.length) lines.push('', `# Found by discover.js on ${today}`,
      ...added.map(f => `${f.name} | ${f.slug} | ${f.ats}`));
    fs.writeFileSync(txtPath, lines.join('\n') + '\n');
  }
  fs.writeFileSync(seenPath, JSON.stringify(seen, null, 1));

  console.log(`${found.length} hiring creatives in Europe: ${added.length} added to companies.txt, ` +
              `${matched.length} already listed and now matched to their board\n`);
  for (const f of [...matched, ...added])
    console.log(`  ${f.name.padEnd(32)} ${f.ats.padEnd(15)} ${f.roles.slice(0, 2).map(r => r.title).join(' / ')}`);
})();
