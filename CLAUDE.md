# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

A German-language PWA ("Personen-Gedächtnis" / person memory) for privately tracking people, family relationships, and notes, with voice input/output and optional Google Drive sync. It is a **plain static site with zero build tooling**: no `package.json`, no bundler, no framework, no test suite. Source files are served as-is, and the repo is deployed via GitHub Pages from `main`.

## Running it

```
node dev-server.js
```

Serves the repo at `http://localhost:8123` (`dev-server.js` is a minimal static file server, explicitly **not part of the shipped app**). There is no build, lint, or test command — none exist in this project.

The service worker (`sw.js`) only registers over `https:`, so it's inactive when running locally over `http://localhost`.

## Architecture

All app code lives in `js/` as native ES modules loaded directly by `index.html` (`<script type="module" src="js/app.js">`), with no transpilation step. Data flows one way: `store.js` owns state, everything else reads/mutates through it and re-renders reactively via `Store.onChange`.

- **`store.js`** — the single source of truth. Holds the in-memory DB (`persons`, `relations`, `tags`), persists it to `localStorage`, and runs schema migrations on load (`migrate()`) so older saved data gains new fields without a version bump. Exposes derived-data helpers (`childrenOf`, `partnerOf`, `grandparentsOf`, `ageOf`/`ageText`, etc.) that the rest of the app relies on instead of reading `db` directly. Data model notes:
  - A person has `partnerId` (single) and `parentIds` (array — supports multiple parents), plus a separate free-form `relations` list (`{fromId, toId, label}`) for arbitrary relationships (Opa, Tante, Chef, …) that aren't part of the direct family tree.
  - Each link type has a matching removal path that leaves both people (and their notes) intact — `removePartner`, `removeParentChild`, `removeRelation`/`removeRelationBetween` — exposed both in the detail view (✕ on the row) and as assistant mutations. Grandparent/grandchild rows are *derived* from `parentIds`, so they are not directly removable; the link in between is. Correcting a wrong relationship must never go through `delete_person`.
  - Every person must belong to at least one tag/category; `UNSORTED_TAG_ID` is the fixed, undeletable fallback — tag helpers (`addTagToPerson`/`removeTagFromPerson`/`deleteTag`) all maintain this invariant.
  - Birth/death are stored as `{date, year, estimated}`-shaped objects supporting partial knowledge (exact date, year only, or age-at-capture); age math is derived, not stored.
  - A birthday requires a **full** `birth.date` — day and month, not just a year — so `hasBirthday()` gates the birthday list and calendar sync, and deceased people are excluded. `birthdayReminder` defaults to `false` on every person.
  - `Settings` (also in this file) persists Google Client ID, Anthropic API key, and TTS preference to `localStorage` — these are user-entered in the Settings tab and must never be hardcoded into source.
- **`app.js`** — all UI and navigation. Renders one of three tabs (`assistant`, `persons`, `settings`) into `#view` by replacing `innerHTML` with template strings and re-binding event listeners after every render (no virtual DOM, no component framework). Modals go through a single `#modal-root` element (`openPersonForm`, `openRelationForm`, `openPersonPicker`). Because every render replaces the DOM, listeners that must live on `document` (e.g. the category filter's outside-click/Escape handling) are registered once at module level, never inside a render function.
- **`nlu.js`** — hybrid natural-language understanding for the assistant tab. `tryRules()` matches German regex patterns first (free, offline: "Wie alt ist …", "Welche Kinder hat …", etc.), returning `null` when nothing matches. On a miss, `askClaude()` sends the database plus recent chat history as JSON to the Claude API (`claude-haiku-4-5-20251001`) with a system prompt that must return strict JSON (`{reply, mutations}`); `applyMutations()` then replays the returned mutation ops (`create_person`, `update_person`, `set_partner`, `remove_partner`, `add_parent_child`, `remove_parent_child`, `add_relation`, `remove_relation`, `add_note`, `add_tag`, `remove_tag`, `delete_person`) back into `Store`. When editing the rule patterns or the mutation schema, keep both `tryRules()`'s regexes and `SYSTEM_PROMPT`'s documented op list in sync.
- **`google.js`** — shared Google sign-in for `drive.js` and `calendar.js`. Keeps **one token client per OAuth scope** so a user who only syncs to Drive is never asked for calendar permission; rebuilds the client when the Client ID changes. All Google API calls go through its `api(scope, path, options)`.
- **`calendar.js`** — writes birthdays into the user's Google Calendar as yearly recurring all-day events (scope `calendar.events`, calendar `primary`). **This is the reminder mechanism**: a static PWA cannot wake itself at a point in time (the Notification Triggers API was abandoned by Chrome) and real Web Push requires an application server to sign/send with VAPID keys — there is no backend here by design. The calendar app does the reminding instead. The app only ever touches events it created itself, tracked by `calendarEventId` on the person; anything else in the calendar is left alone. Google counts reminder lead time in minutes before midnight of the event day, so `calendarLeadDays` is converted as `days * 1440 - 540` (09:00 on that day), with 0 meaning midnight.
- **`drive.js`** — optional sync of the whole DB as a single Google Drive file (`personen-gedaechtnis.json`, scope `drive.file`). Conflict resolution is last-write-wins by comparing `Store.db.updatedAt` timestamps on connect; after that, local changes are debounced (1.5s) and pushed via `scheduleSave()`, wired up by listening to `Store.onChange`.
- **`tree.js`** — computes the family-tree subtree for a given root person (their parents down through all descendants, plus married-in partners for completeness) and lays it out as raw SVG. People appearing twice (e.g., someone with children from two partners) are drawn as marked duplicates rather than deduplicated.
- **`speech.js`** — thin wrapper around the Web Speech API for reading assistant replies aloud, preferring a local `de-DE` voice.
- **`sw.js`** — app-shell cache; network-first for same-origin requests, falling back to cache when offline. Cross-origin calls (Google, Anthropic) always go straight to the network.

## Conventions

- All UI copy, comments, and user-facing strings are in **German**; keep new code consistent with this.
- **Categories are never disclosed as a property of a person.** They exist only for filtering/organising in the UI. The assistant must not name a category in any answer about a person — neither the rule-based answers in `nlu.js` nor Claude (per-person tag names are deliberately kept out of the API payload; only a derived `kontext` field is sent). The one permitted disclosure is the coarse private/business classification, surfaced by `contextOf`/`contextLabel` in `store.js` and used for the "Woher kenne ich …?" question. Classification is heuristic on the category name (`BUSINESS_TAG_WORDS`), so custom categories are covered too. Assigning categories via the assistant (`add_tag`/`remove_tag`) stays allowed, as does the "Wer ist alles in Kategorie X?" query — that one asks *about a category*, not about a person.
- Categories are also kept visually cheap in the person list: one compact multi-select dropdown at the top (not sticky — it scrolls away with the list), and no per-card category badges.
- No secrets are ever committed — the Google Client ID and Anthropic API key are runtime user input stored only in `localStorage` (`Settings`), never in source files.
