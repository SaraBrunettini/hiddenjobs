#!/usr/bin/env node
/**
 * Finds companies the board does not know yet and adds the ones hiring
 * creatives in Europe to companies.txt. Runs every morning in GitHub Actions,
 * before the jobs are fetched.
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
const { ATS, fetchFeed, pool, discipline, country, workplace, inEurope, workdayOwner, boardOn } = require('./fetch-jobs.js');

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
  { ats: 'teamtailor',      url: '*.teamtailor.com',            slug: /^https?:\/\/([a-z0-9-]+)\.teamtailor\.com/i },
  { ats: 'breezy',          url: '*.breezy.hr',                 slug: /^https?:\/\/([a-z0-9-]+)\.breezy\.hr/i },
  { ats: 'pinpoint',        url: '*.pinpointhq.com',            slug: /^https?:\/\/([a-z0-9-]+)\.pinpointhq\.com/i },
  { ats: 'homerun',         url: '*.homerun.co',                slug: /^https?:\/\/([a-z0-9-]+)\.homerun\.co/i },
  /* A Workday board is the company's server and its site name together -
     philips.wd3/jobs-and-careers - and the site name keeps its case. */
  { ats: 'workday',         url: '*.myworkdayjobs.com',          keepCase: true,
    slug: /^https?:\/\/([a-z0-9-]+\.wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[a-z]{2}\/)?(?!wday\/|[a-z]{2}-[a-z]{2}\/?$)([\w-]+)/i,
    join: m => `${m[1].toLowerCase()}/${m[2]}` },
];

/* Path segments that are the tool's own pages, not a company. */
const NOT_A_BOARD = /^(embed|api|j|jobs|v\d|www|app|help|support|static|assets|careers|login|oauth|sitemap.*|robots\.txt|favicon\.ico|_next|cdn-cgi|search|privacy|terms|cdn|feed|developers|status|blog|partners|integrations|scripts|images)$/i;

/* Two crawls are about two months of the web - plenty, and a company that
   only shows up further back has probably moved on. */
const CRAWLS = 2;
/* The index is a free service run on goodwill: one request at a time, a
   pause between them, and a cap on how much is read per tool. */
const MAX_PAGES = 40;
const PAUSE_MS = 1500;
/* A company checked and passed over is looked at again after this long -
   it may have started hiring designers since - a slice at a time, so a
   daily run stays short. */
const RECHECK_DAYS = 14;
const MAX_RECHECKS = 3000;

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
        let slug;
        try { slug = decodeURIComponent(source.join ? source.join(m) : m[1]); } catch { continue; }
        if (!source.keepCase) slug = slug.toLowerCase();
        const last = slug.split('/').pop();
        if (!NOT_A_BOARD.test(last) && /^[\w.\/-]{2,80}$/.test(slug)) slugs.add(slug);
      }
    }
  }
  console.log(`  ${crawl} ${source.url.padEnd(28)} ${String(Math.min(pages, MAX_PAGES)).padStart(3)}/${pages} pages, ${slugs.size} boards`);
  return slugs;
}

/* Venture investors' job boards list every role at the companies they back -
   tens of thousands, mostly at product companies, which is where product
   designers work. They are read only to learn which companies hire
   designers in Europe and where those companies post: each role links to
   the company's own careers page or hiring tool. Most run on Getro. */
const GETRO_BOARDS = ['careers.atomico.com', 'indexventures.getro.com', 'careers.creandum.com',
  'jobs.accel.com', 'jobs.dawncapital.com', 'opportunities.northzone.com'];
const GETRO_QUERIES = ['designer', 'UX', 'design'];
const GETRO_MAX_PAGES = 40;
const GETRO_EVERY_DAYS = 7;

async function getroCollection(host) {
  try {
    const res = await fetch(`https://${host}/jobs`, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; HiddenJobs)' },
      signal: AbortSignal.timeout(30000) });
    const html = res.ok ? await res.text() : '';
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    return m && JSON.parse(m[1]).props.pageProps.network.id;
  } catch { return null; }
}

async function getroDesignHiring() {
  const orgs = new Map();
  for (const host of GETRO_BOARDS) {
    const id = await getroCollection(host);
    if (!id) { console.log(`  ${host.padEnd(30)} unavailable`); continue; }
    let roles = 0;
    for (const query of GETRO_QUERIES) {
      for (let page = 0; page < GETRO_MAX_PAGES; page++) {
        await wait(400);
        let jobs = [];
        try {
          const res = await fetch(`https://api.getro.com/api/v2/collections/${id}/search/jobs`, {
            method: 'POST', signal: AbortSignal.timeout(30000),
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ hitsPerPage: 20, page, filters: { page }, query }),
          });
          jobs = res.ok ? ((await res.json()).results || {}).jobs || [] : [];
        } catch {}
        if (!jobs.length) break;
        for (const j of jobs) {
          const name = j.organization && String(j.organization.name || '').trim();
          if (!name || !discipline(j.title)) continue;
          const places = (j.locations || []).concat(j.searchable_locations || []);
          const europe = places.some(l => /^europe$|emea/i.test(l) || inEurope(country(l), l, ''));
          if (!europe) continue;
          roles++;
          const o = orgs.get(name) || { name, boards: new Map() };
          const b = boardOn(String(j.url || ''));
          if (b) o.boards.set(`${b.ats}:${b.slug.toLowerCase()}`, b);
          orgs.set(name, o);
        }
      }
    }
    console.log(`  ${host.padEnd(30)} ${roles} design roles in Europe`);
  }
  return [...orgs.values()];
}

/* Recruiters, staffing firms and talent marketplaces post other companies'
   roles. The board lists employers only, so none is ever added. */
const NOT_EMPLOYER = /recruit|talent|staffing|headhunt|search partners|executive search|\bsearch$|personalberatung|personaldienst|employment agency|hiring|\bjobs?\b|careers?\b|^(lemon\.io|mercor|contra|toptal|upwork|fiverr|braintrust|turing|crossover|andela|arc\.dev|gun\.io|a\.team|jobgether|outsized|malt)$/i;

/* Remote job sites - We Work Remotely, Himalayas, Dribbble. Like the
   investors' boards they are read only for company names: which companies
   are hiring designers that someone in Europe can take. The roles are then
   read from the companies themselves. Their apply links lead through their
   own pages, so a company is added by name and its board found on each run. */
const REMOTE_EVERY_DAYS = 7;
const REMOTE_MAX_AGE_DAYS = 60;
const UA = { 'user-agent': 'Mozilla/5.0 (compatible; HiddenJobs)' };
const recentEnough = d => Number.isFinite(d) && Date.now() - d < REMOTE_MAX_AGE_DAYS * 864e5;
const openToEurope = places => !places.length || places.some(l =>
  /anywhere|worldwide|europe|emea|\bcet\b|\bgmt\b/i.test(l) || inEurope(country(l), l, ''));

async function getText(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30000) });
      if (res.ok) return await res.text();
      if (res.status !== 429) return null;
    } catch {}
    await wait(30000 * (i + 1));   // asked to slow down
  }
  return null;
}

const rssItems = xml => [...String(xml || '').matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]);
const rssTag = (item, tag) => {
  const m = item.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].replace(/^<!\[CDATA\[|\]\]>$/g, '').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").trim() : '';
};

async function remoteDesignHiring() {
  const names = new Set(), boards = new Map();
  const take = (company, title, places, when, applyUrl) => {
    company = String(company || '').replace(/\s+\d+$/, '').trim();   // "Intetics 2"
    if (!company || NOT_EMPLOYER.test(company.trim()) || !discipline(title) || !openToEurope(places) || !recentEnough(when)) return;
    names.add(company.trim());
    /* An apply link straight to a hiring tool the board reads gives the
       company's own board - no guessing needed. */
    const b = applyUrl && boardOn(String(applyUrl));
    if (b) boards.set(company.trim(), b);
  };
  const json = async url => { try { return JSON.parse(await getText(url) || 'null'); } catch { return null; } };
  let before;

  /* We Work Remotely: "Company: Role", with the region it is open to. */
  for (const cat of ['remote-design-jobs', 'remote-product-jobs']) {
    for (const it of rssItems(await getText(`https://weworkremotely.com/categories/${cat}.rss`))) {
      const t = rssTag(it, 'title'), i = t.indexOf(':');
      if (i > 0) take(t.slice(0, i), t.slice(i + 1), [rssTag(it, 'region')].filter(Boolean), Date.parse(rssTag(it, 'pubDate')));
    }
  }
  console.log(`  We Work Remotely: ${names.size} companies`);

  /* Himalayas: a search, each role listing the countries it is open to. */
  before = names.size;
  for (const q of ['product designer', 'ux designer', 'ui designer', 'brand designer', 'motion designer']) {
    for (let page = 1; page <= 4; page++) {
      await wait(4000);
      let d = null;
      try { d = JSON.parse(await getText(`https://himalayas.app/jobs/api/search?q=${encodeURIComponent(q)}&page=${page}`) || 'null'); } catch {}
      const jobs = (d && d.jobs) || [];
      if (!jobs.length) break;
      for (const j of jobs) take(j.companyName, j.title, j.locationRestrictions || [], (j.pubDate || 0) * 1000);
    }
  }
  console.log(`  Himalayas: ${names.size - before} more`);

  /* Dribbble: "Company is hiring for a position of Role in Place". */
  const before2 = names.size;
  for (const it of rssItems(await getText('https://dribbble.com/jobs.rss'))) {
    const m = rssTag(it, 'title').match(/^(.*?) is hiring for a position of (.*?)(?: in (.*))?$/);
    if (m) take(rssTag(it, 'dc:creator') || m[1], m[2], m[3] ? [m[3]] : [], Date.parse(rssTag(it, 'pubDate')));
  }
  console.log(`  Dribbble: ${names.size - before2} more`);

  /* Remote OK: one call for its design tag; asks for a link back if its
     listings are shown, which they are not - only the company is taken. */
  before = names.size;
  for (const j of ((await json('https://remoteok.com/api?tag=design')) || []).slice(1))
    take(j.company, j.position, [j.location].filter(Boolean), Date.parse(j.date), j.apply_url);
  console.log(`  Remote OK: ${names.size - before} more`);

  /* Working Nomads: its latest roles, each with a category and the places
     it is open to. */
  before = names.size;
  for (const j of (await json('https://www.workingnomads.com/api/exposed_jobs/')) || [])
    if (/design/i.test(j.category_name || '')) take(j.company_name, j.title, String(j.location || '').split(/,\s*/).filter(Boolean), Date.parse(j.pub_date));
  console.log(`  Working Nomads: ${names.size - before} more`);

  /* Arbeitnow: German and European roles, three hundred a page. */
  before = names.size;
  for (let page = 1; page <= 5; page++) {
    await wait(1500);
    const d = await json(`https://www.arbeitnow.com/api/job-board-api?page=${page}`);
    const jobs = (d && d.data) || [];
    if (!jobs.length) break;
    for (const j of jobs) take(j.company_name, j.title, j.remote ? ['Remote', j.location] : [j.location], (j.created_at || 0) * 1000);
  }
  console.log(`  Arbeitnow: ${names.size - before} more`);

  /* Authentic Jobs and EU Remote Jobs run WP Job Manager, whose job feed
     takes a keyword. */
  for (const [label, base] of [['Authentic Jobs', 'https://authenticjobs.com/'], ['EU Remote Jobs', 'https://euremotejobs.com/']]) {
    before = names.size;
    for (const kw of ['designer', 'ux']) {
      for (const it of rssItems(await getText(`${base}?feed=job_feed&search_keywords=${kw}`, 1))) {
        const where = rssTag(it, 'job_listing:location');
        take(rssTag(it, 'job_listing:company'), rssTag(it, 'title'),
          label === 'EU Remote Jobs' ? ['Europe'] : [where || 'Anywhere'], Date.parse(rssTag(it, 'pubDate')));
      }
    }
    console.log(`  ${label}: ${names.size - before} more`);
  }
  return [...names].map(name => ({ name, board: boards.get(name) }));
}

/* UX Jobs (jobs.uxjobs.io, also behind UX Speakeasy's and X2Talent's
   boards) links each of its newest design roles straight to the company's
   own posting. Its homepage is read once a week for those links - its
   robots.txt welcomes general readers there, keeping only /api/ and /go/
   private - and each linked board is checked like any other. */
async function uxJobsBoards() {
  const html = await getText('https://jobs.uxjobs.io/');
  const found = new Map();
  for (const [, url] of String(html || '').matchAll(/href="(https?:\/\/[^"#]+)"/g)) {
    const b = boardOn(url);
    if (b) found.set(`${b.ats}:${b.slug.toLowerCase()}`, b);
  }
  console.log(`  UX Jobs: ${found.size} company boards linked`);
  return found;
}

/* A board's feed rarely says whose it is, so the name comes from the feed
   where it can and from the board name otherwise: acme-studio -> Acme Studio. */
async function companyName(slug, ats) {
  if (ats === 'workday') return workdayOwner(slug);
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
    /* Boards whose feed says whose it is. */
    const board = ATS[ats];
    if (board.owner && ats !== 'workable') {
      const res = await fetch(board.url(slug), { signal: AbortSignal.timeout(20000) });
      const d = res.ok && (board.format === 'xml' ? await res.text() : await res.json());
      const name = d && board.owner(d);
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

  /* Boards looked at before and passed over, and the crawls already read:
     a crawl comes out about once a month, so most mornings there is no
     crawl to read and the run only re-checks boards that have gone stale. */
  const seenPath = `${__dirname}/discovered.json`;
  let state = {};
  try { state = JSON.parse(fs.readFileSync(seenPath, 'utf8')); } catch {}
  const seen = state.boards || {};
  const fresh = d => Date.now() - Date.parse(d) < RECHECK_DAYS * 864e5;

  const list = await getIndex(`${INDEX}/collinfo.json`);
  let crawls = [];
  try { crawls = JSON.parse(list).slice(0, CRAWLS).map(c => c.id); } catch {}
  const unread = crawls.filter(c => !(state.crawls || []).includes(c));
  if (!crawls.length) console.log('Common Crawl index unavailable; re-checking known boards only.');

  const candidates = new Map();
  if (unread.length) {
    console.log(`Reading ${unread.join(', ')}`);
    for (const source of SOURCES)
      for (const crawl of unread)
        for (const slug of await slugsFromCrawl(crawl, source)) {
          const key = `${source.ats}:${slug}`;
          if (!haveBoard.has(key) && !(seen[key] && fresh(seen[key])))
            candidates.set(key, { ats: source.ats, slug });
        }
  } else if (crawls.length) console.log(`No new crawl since ${crawls[0]}.`);
  const newBoards = candidates.size;

  /* Then the oldest boards passed over, oldest first. */
  Object.entries(seen)
    .filter(([key, d]) => !fresh(d) && !haveBoard.has(key) && !candidates.has(key))
    .sort((a, b) => a[1].localeCompare(b[1]))
    .slice(0, MAX_RECHECKS)
    .forEach(([key]) => {
      const i = key.indexOf(':');
      candidates.set(key, { ats: key.slice(0, i), slug: key.slice(i + 1) });
    });
  console.log(`\n${newBoards} new boards, ${candidates.size - newBoards} re-checked`);

  /* Once a week, the investors' boards. A company whose roles link to a
     hiring tool is checked like any other board; one with its own careers
     site is added by name, for the daily run to find its board. */
  const byName = [], byRemote = [];
  if (!(state.getroAt && Date.now() - Date.parse(state.getroAt) < GETRO_EVERY_DAYS * 864e5)) {
    console.log('Reading investors\' job boards');
    for (const o of await getroDesignHiring()) {
      if (haveName.has(o.name.toLowerCase()) || NOT_EMPLOYER.test(o.name)) continue;
      const boards = [...o.boards.entries()].filter(([key]) => !haveBoard.has(key));
      if (boards.length) boards.forEach(([key, b]) => candidates.set(key, { ...b, name: o.name }));
      else if (!o.boards.size) byName.push(o.name);
    }
    state.getroAt = today;
    console.log(`${byName.length} more hiring designers in Europe through their own careers sites`);
  }
  if (!(state.remoteAt && Date.now() - Date.parse(state.remoteAt) < REMOTE_EVERY_DAYS * 864e5)) {
    console.log('Reading remote job sites');
    /* A shorter form of a company already listed ("Bjak" for Bjakcareer) is the same company. */
    const listed = [...haveName];
    const known = n => haveName.has(n) || (n.length >= 4 && listed.some(h => h.startsWith(n) && /^[a-z]/.test(h.slice(n.length))));
    for (const { name, board } of await remoteDesignHiring()) {
      if (known(name.toLowerCase())) continue;
      const key = board && `${board.ats}:${board.slug.toLowerCase()}`;
      if (board && !haveBoard.has(key)) candidates.set(key, { ...board, name });
      else if (!board) byRemote.push(name);
    }
    for (const [key, b] of await uxJobsBoards())
      if (!haveBoard.has(key) && !candidates.has(key)) candidates.set(key, b);
    state.remoteAt = today;
  }

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
  for (const f of await pool(found, 10, async f => ({ ...f, name: f.name || await companyName(f.slug, f.ats) }))) {
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

  const named = [...new Set(byName)].filter(n => !haveName.has(n.toLowerCase())).sort();
  named.forEach(n => haveName.add(n.toLowerCase()));
  const remote = [...new Set(byRemote)].filter(n => !haveName.has(n.toLowerCase())).sort();
  if (added.length || matched.length || named.length || remote.length) {
    if (added.length) lines.push('', `# Found by discover.js on ${today}`,
      ...added.map(f => `${f.name} | ${f.slug} | ${f.ats}`));
    if (named.length) lines.push('', `# Hiring designers in Europe on investors' job boards, ${today}; board guessed on each run`,
      ...named);
    if (remote.length) lines.push('', `# Hiring designers open to Europe on remote job sites, ${today}; board guessed on each run`,
      ...remote);
    fs.writeFileSync(txtPath, lines.join('\n') + '\n');
  }
  /* A crawl counts as read only if the index answered for it. */
  const read = [...new Set([...(state.crawls || []), ...unread])].filter(c => crawls.includes(c));
  fs.writeFileSync(seenPath, JSON.stringify({ crawls: read, getroAt: state.getroAt, remoteAt: state.remoteAt, boards: seen }, null, 1));

  console.log(`${found.length} hiring creatives in Europe: ${added.length} added to companies.txt, ` +
              `${matched.length} already listed and now matched to their board, ${named.length + remote.length} added by name\n`);
  for (const f of [...matched, ...added])
    console.log(`  ${f.name.padEnd(32)} ${f.ats.padEnd(15)} ${f.roles.slice(0, 2).map(r => r.title).join(' / ')}`);
})();
