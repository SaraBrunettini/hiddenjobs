# CreativeCase board

Creative jobs across Europe, read straight from the companies’ own career pages.
No scraping middlemen, no reposts, no expired listings. Free to run, free to use.

## How it works

Greenhouse, Lever, Ashby, Recruitee, Personio, Workable and SmartRecruiters
each publish an open, keyless feed for every company that uses them — the same
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

A company with no feed can be listed by its careers page instead:

```
Atomix | https://atomix.ai/careers | page
```

The page is read for the job markup most careers sites include so Google can
list their roles, and if the page just links out to one of the boards above,
that board's feed is read instead.

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
