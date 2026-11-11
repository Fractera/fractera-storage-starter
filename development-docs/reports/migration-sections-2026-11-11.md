# Migration «block → section» — 2026-11-11

Node step 717-2: one word, «section», for a designed part of a page; a section is one folder `components/sections/<kind>/`; a page's
list is `body`. «Block» keeps one meaning — the address of a container (`data-block`, `#block=`, `npm run blocks:ids`).
Script `scripts/migrate-sections.mjs`, map `scripts/migrate-sections.map.json`.

## Done (2)

- rewritten `app/[lang]/(publicLayer)/_data/en.json`
- rewritten `app/[lang]/(publicLayer)/_data/ru.json`

## For your eye (1)

Each line: change the sense «section» to «section» (in Russian «секция»), keep the address; a line that is right as it is stays.

- `app/[lang]/(publicLayer)/_widgets/static/widget-static-storage-landing/README.md:4` — «block» left — the sense «section» becomes «section»; the address (`data-block`) stays: «elements: the page is 'bare', this widget draws it from the items of the page data, a section is 'section-head' and the blocks up to the»

## Then

`npm run prebuild`, `npx tsc --noEmit`, the build, `npm run eyes` on a page with sections, one commit.
