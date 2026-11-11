# CreativeCase board

Creative jobs across Europe, read straight from the companies’ own career pages.
No scraping middlemen, no reposts, no expired listings. Free to run, free to use.

## How it works

Greenhouse, Lever, Ashby, Recruitee, Personio, Workable, SmartRecruiters,
Teamtailor, Homerun, Breezy and Pinpoint each publish an open, keyless feed for every company that uses them — the same
feed the company’s own careers page reads.
`fetch-jobs.js` reads those feeds, keeps the creative roles in Europe, and writes
`jobs.json`. `index.html` renders it. A GitHub Action re-runs it every morning
at 06:00 UTC and commits the result.

No API keys. No accounts. No database. No server. Nothing to pay for.

## Adding a company

Add a line to `companies.txt`. If they publish a feed, their roles appear on the
next run. Their board name is guessed from the company name; once a guess works
it is cached in `companies.json`, so later runs are faster.

If the guess picks the wrong board, name it yourself:

```
Fever | feverup | greenhouse
```

Big brands often use Workday, whose addresses can't be guessed, so they are
listed by server and site name, read off their careers address
(`philips.wd3.myworkdayjobs.com/en-US/jobs-and-careers`):

```
Philips | philips.wd3/jobs-and-careers | workday
```

Workday sites are searched for creative roles rather than read whole.

Brands with their own careers site - Nike, adidas, PUMA - are read from the
sitemap the site keeps for search engines. Give the site (its `robots.txt`
names the sitemap) or the sitemap itself:

```
Nike | https://careers.nike.com/ | sitemap
```

Oracle Recruiting sites (ITV, the Guardian) are searched like Workday ones,
named by server and site from the careers address:

```
ITV | fa-euup-saasfaprod1.fa.ocs/CX_1 | oracle
```

UK universities and colleges are read from jobs.ac.uk, where they post their
own vacancies; each role appears under the institution that posted it. The
line names the jobs.ac.uk categories to read.

A role that gives only a closing date - the BBC's do - is dated from the day
the board first saw it, as long as it hasn't closed.

Only roles whose address reads as creative are opened, so a sitemap of
thousands of roles costs a few dozen page reads.

A company with no feed can be listed by its careers page instead:

```
Atomix | https://atomix.ai/careers | page
```

The page is read for the job markup most careers sites include so Google can
list their roles, and if the page just links out to one of the boards above,
that board's feed is read instead.

## Finding new companies

`discover.js` runs every morning, before the jobs are fetched. Each hiring tool gives a company a jobs page
at a predictable address, and Common Crawl, a free public archive of the
web, lists the ones it has seen. Every company not already on the list has
its feed read once, and those with a creative role open in Europe are added to
`companies.txt` under a dated `# Found by discover.js` heading. Delete any line
you don't want. A company already listed whose board was never found gets
its board filled in. Boards that were checked and passed over are remembered
in `discovered.json` and looked at again after 14 days, in case they have
started hiring designers. Common Crawl publishes about once a month, so it is
only read when there is a new crawl.

Discovery also reads, once a week, the job boards of venture investors
(Atomico, Index, Creandum, Accel, Dawn, Northzone) and remote and design job sites (We
Work Remotely, Himalayas, Dribbble, Remote OK, Working Nomads, Arbeitnow,
Authentic Jobs, EU Remote Jobs) for companies hiring designers in
Europe. Only the company is taken from them - its roles are read from the
company itself. Recruiters, staffing firms and talent marketplaces are
never added.

## Sharing and following

Every view of the board has its own link: the address records the
discipline, location, workplace and contract type, so `?d=ux` opens Product
& UX and `?d=brand&w=Remote` remote brand roles. **Copy link** copies it.

Each morning's run also writes RSS feeds - `feed.xml` for every role and
`feeds/<discipline>.xml` for each tab (`feeds/product-ux.xml` and so on).
Links in the feeds point at `SITE_URL`, which defaults to the GitHub Pages
address; set it in the workflow if the board moves to its own domain.

## Running it yourself

```
node fetch-jobs.js
```

Needs Node 18 or newer. Takes about a minute on a cold run.

## Tuning what counts as creative

`DISCIPLINES` in `fetch-jobs.js` decides which roles are kept and how each is
labelled — first match wins, so order matters. `NOT_CREATIVE` drops titles that
mention design in passing: iOS engineers on a design system, security
researchers, brand partnerships managers.
