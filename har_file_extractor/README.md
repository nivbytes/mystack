# 📊 HAR Pulse v2.2

A single-file, browser-based HAR (HTTP Archive) viewer for two audiences at once: non-technical
users who just want to know "is this page fast, and what's broken," and technical users (QA/devs)
who need full request-level detail. Everything runs client-side — no server, no upload, nothing
leaves your browser.

## Features

### Simple mode (for anyone)
- Plain-English headline: total load time, failed request count
- Stat cards: Load time, Failed, Heaviest file, Fastest, Slowest (name + value, tap to reveal full
  name if truncated)
- Color-coded waterfall timeline (green = fast/OK, amber = slow/redirect, red = failed), with each
  bar broken into stacked DNS / Connect-SSL / Wait (TTFB) / Download phase segments so you can see
  *why* a request was slow, not just that it was — hover any bar for one combined tooltip listing
  the request name, total time, and every phase present
- Legend chips double as OR-filters — tap "Failed" to show only failed requests
- Multi-select API-name search (checkbox list with counts, Clear all / Apply)
- **Custom speed thresholds**: override the 500ms "slow" cutoff per API — recolors the timeline,
  legend counts, and cards live
- **API-wise time**: cumulative time spent per API across all its calls, sorted by total cost —
  surfaces endpoints that are cheap per-call but expensive in aggregate
- **LLM usage & cost panel** (collapsible): when the HAR contains LLM API traffic, sniffs
  prompt/completion token counts out of the response body — preferring `total_prompt_tokens`/
  `total_completion_tokens` when an API reports them, falling back to the plain
  `prompt_tokens`/`completion_tokens` otherwise, and handling streamed responses by taking the
  finalized cumulative usage, not an early chunk — then estimates cost (to 2 decimal places) per
  model against a pricing table you edit. Toggle between **By model** and **By API** grouping — API
  grouping sums each endpoint's calls/tokens/cost from its own entries' models (still costed per
  entry against that entry's model), and lists which model(s) contributed via a `Model(s)` column
  when more than one model hit the same endpoint. The pricing editor only lists models actually
  present in the current file (still lets you add/remove among them) and fits within the viewport
  on any screen size. Renders nothing on the ~99% of HAR files with no LLM traffic
- **Insights panel** (collapsible): an automatic "HAR linter" flagging duplicate requests
  (grouped by method + name, so `GET /x` and `POST /x` are counted separately, not conflated),
  uncompressed text responses, static assets missing cache headers, oversized payloads (states the
  actual largest size found, not just the threshold), and a main-document response missing common
  security headers (CSP/HSTS/X-Content-Type-Options). Each finding's affected-request list shows
  distinct requests with a `×N` call count rather than repeating the same name

### Advanced mode (for QA/devs)
- Dense, virtualized table (handles 1000+ requests without freezing): Status, Method, Name, Model,
  Size, Start Time, End Time, Time
- Multi-select column-header filters for Status, Method, Name, and Model — checkbox lists with
  per-option counts, Clear/Apply, Default/A–Z sort for Name
- Type filter chips: All / JS / CSS / Image / Font / XHR-Fetch / **Preflight** (detected via
  `OPTIONS` + CORS request headers, not just guessed from the URL)
- Active-filters bar showing every applied filter plus "Showing X of Y requests," with one-tap
  Clear all
- Inline accordion row expansion — click a row to expand Headers / Payload / Response right below
  it (chevron rotates, no separate detail panel)
- Payload and Response are pretty-printed with JSON syntax coloring
- **Full-text search** across name, domain, payload, and response bodies — matches are highlighted
  in the expanded panel with a "3 of 12" counter and up/down navigation between occurrences
- GMT / IST timezone toggle for Start/End Time columns

### 🏗️ Editable API Architecture & Data Flow (v2.2)
- **Visual API Communication**: See what information one API sends to another based on direct evidence observed in the network traffic.
- **Fully Interactive & Editable Graph**: 
  - Add, edit, or delete API nodes and connections manually.
  - Reverse connection direction if the inferred data flow is backwards.
  - Quick-confirm inferred flows with one click, visually differentiating observed vs. inferred vs. confirmed connections.
- **Persistent App Knowledge**: 
  - Graph edits, custom API nodes, confirmed relationships, and locked canvas positions are preserved as "App Knowledge".
  - Knowledge is persisted across sessions and merges safely with newly uploaded HAR files.
  - Export or import App Knowledge as a standalone JSON blueprint to share your architecture model with your team.
- **Smart Positioning Engine**: A DAG topological auto-layout provides an initial clean structure, and user-dragged node coordinates are locked so edits never disrupt your custom layout.
- **Plain-English Flow Narrative**: Automatically tells the story of how data travels across services (e.g. *The Account API sends Account ID and Account Name to the Provisioning API*).
- **Clean Filters**: Search data attributes, filter by API, filter Business vs Technical data, and toggle *Hide technical data*.

### Everywhere
- ms / s / min:sec time-unit toggle, shared across both modes, with a space between number and
  unit (`500 ms`, `2.3 s`, `3 min 12 s`)
- **Dark mode** toggle (☀️/🌙), backed by CSS custom properties so the whole app re-themes at once
- **Shareable/bookmarkable view**: the active mode and filters are encoded into the URL hash
  (debounced, via `history.replaceState` so it doesn't spam browser history) and restored on load.
  The "🔗 Copy link" button always computes and commits the hash fresh at click time — never the
  stale in-flight debounced value — so what's copied always matches what's on screen. The HAR file
  itself is never in the URL — a shared link restores your filter *selections*; the upload screen
  shows a banner when it detects pending filters, prompting you to re-upload the same file
- Excel export respects the current filters — exports whichever entries are on screen in the active
  mode (Simple name/color filters, or Advanced's full filter+sort state), and only the full dataset
  when nothing is filtered, matching prior behavior. Filtered exports get a `_filtered` filename
  suffix so a partial export is never mistaken for the complete file
- Accurate stats: transferred size uses `bodySize + headersSize` (what DevTools shows), falling
  back to uncompressed content size only when a capture tool didn't record wire bytes; every entry
  in `log.entries` is counted, with "Showing X of Y" whenever a filter narrows the view
- Model/GPT version detection from either the request payload or response body, recognizing
  several key-naming conventions (`model`, `GPTVersion`, `gpt_version`, `llm_model`)
- Friendly empty state (drag-and-drop) and a clear error state that explains what a valid HAR
  export looks like

## How to Use

1. **Open the Application** — open `index.html` in any modern browser. No install, no build.
2. **Upload a HAR file** — drag a `.har` file onto the drop zone, or click to browse.
   - Don't have one? In Chrome: DevTools → Network tab → reload the page → right-click any
     request → "Save all as HAR with content."
3. **Simple mode** — read the headline, check the timeline, tap the legend chips to filter by
   status, or set custom speed thresholds for specific APIs.
4. **Advanced mode** — click "Show technical details," then sort/filter the table, search across
   payloads and responses, and expand any row for full detail.
5. **Export** — click "📥 Export to Excel" anytime to download the current file's stats and request
   table; if a filter is active, only the filtered/visible requests are exported.

## Technical Details

- **Framework**: React 18 (CDN, production build), JSX compiled in-browser via Babel Standalone —
  no build step, no `npm install`
- **Styling**: Tailwind CSS (Play CDN) with a custom paper/ink/signal-color palette; IBM Plex
  Sans/Mono typefaces
- **Libraries**: SheetJS (`xlsx`) for Excel export, Floating UI (`@floating-ui/dom` + its `core`
  peer) for viewport-aware popover positioning
- **Rendering at scale**: a hand-rolled virtualized list (variable row heights, so an expanded
  detail panel doesn't need special-casing) — only virtualizes once a result set is actually large
  enough to matter, so short/filtered lists render as plain, natural-height DOM instead
- **Storage**: `sessionStorage` for mode/time-unit/timezone/theme preferences (per-tab, not
  long-term); `localStorage` for the LLM pricing table (a cost-rate config meant to persist across
  files and sessions, unlike the per-tab display preferences)
- **Browser Support**: any modern evergreen browser (Chrome, Firefox, Safari, Edge)

## Version History

### v2.2 — App Knowledge & Editable API Architecture
- **Interactive Graph Canvas**: The API Data Flow graph is now a fully interactive graph editor. Nodes and edges can be added, deleted, confirmed, or directionally reversed.
- **Persistent App Knowledge**: HAR-inferred architectures can now be corrected, enhanced, and saved to localStorage as App Knowledge. Knowledge merges transparently with future HAR uploads.
- **Layout Memory**: The DAG layout engine now records and caches node coordinates. Manual adjustments are preserved across edge insertions and deletions.
- **Improved Data Engine**: Core data flow inference updated to support deterministic topological sorting and custom user metadata.

### v2.1.1 — Fixes + LLM cost grouping
- **LLM usage & cost panel**: added a By model / By API grouping toggle — By API sums each
  endpoint's cost from its own entries (each still costed against its own model's rate), with a
  `Model(s)` column listing which model(s) contributed to that endpoint
- Fixed the shared-link "saved view/filters" banner intermittently not appearing: pasting a shared
  link into a tab that already has the tool open at the same path is a same-document,
  fragment-only navigation per the HTML spec (no reload — just a `hashchange` event), which the
  restore logic never listened for. It now also runs on `hashchange`, not just on mount
- Fixed the "🔗 Copy link" button's temporary "✓ Copied" label shrinking the button enough to
  shift the toolbar's flex-wrap point, causing a visible row jump for the ~1.5s the label was
  shown. The button now has a fixed min-width covering both labels

### v2.1 — Differentiators pass
Six additions aimed at standing apart from both generic HAR viewers and Chrome DevTools' own
Network panel, rather than chasing DevTools feature parity:
- LLM usage & cost insights (token extraction with streamed-response handling, editable per-model
  pricing table, graceful no-op on non-LLM traffic)
- Auto-generated Insights panel (duplicate requests, uncompressed/uncached assets, oversized
  payloads, missing security headers on the main document)
- Waterfall phase breakdown replacing the single-color timeline bar with stacked DNS/Connect/Wait/
  Download segments
- Dark mode, implemented via CSS custom properties backing the existing Tailwind color tokens so
  every component re-themes without per-component edits
- Shareable/bookmarkable URL state for mode + filters (file content itself is never included)
- Excel export now respects active filters instead of always exporting the full dataset

Refined after initial rollout, based on real-file testing:
- Waterfall: dropped the status-colored underline under each bar (redundant with the status dot,
  and mostly a wall of identical amber when most requests share a threshold verdict); replaced
  per-segment tooltips with one combined tooltip per bar listing every phase at once
- Insights and LLM panels are now independently collapsible
- Duplicate-requests finding: fixed a count mismatch where the headline number (grouped by
  method + name) didn't match the affected-request list (grouped by name only) — both now group
  the same way, and the affected list shows `METHOD name ×N` instead of collapsing different
  methods on the same name into one deceptive count
- Oversized-payloads finding: fixed wording that showed the static 1MB-ish threshold
  (`formatBytes(LARGE_PAYLOAD_BYTES)`) in a way that read like the affected file's actual size;
  now states the real largest size found, which stays consistent with the Heaviest File stat card
- "Show affected requests" list: fixed rows silently rendering empty (a flex+truncate CSS
  interaction) by switching to plain block rows; grouped entries now show a `×N` call count
  instead of repeating the same name once per occurrence
- Token extraction: prefers `total_prompt_tokens`/`total_completion_tokens` over the plain
  `prompt_tokens`/`completion_tokens` when an API reports both, and prefers an explicit
  `total_tokens` over summing the parts — matches how this project's APIs actually report usage
- LLM cost now displayed to 2 decimal places (was 4)
- Pricing modal: now lists only models present in the current file (previously pre-filled all
  seeded default models regardless of file contents, which also made the modal too tall); capped
  to 85% of viewport height with a sticky header/footer so it always fits; saving no longer
  discards pricing set for models from a previously loaded file
- Threshold modal: same viewport-height fit applied for consistency
- Copy Link: now computes and commits the URL hash fresh at click time instead of trusting the
  400ms-debounced background sync, which could otherwise copy a stale link if clicked right after
  changing a filter

### v2.0 — React rebuild (HAR Pulse)
Complete rewrite from the ground up: vanilla JS → React + Tailwind, single-file, no build step.
Replaces the old slide-extraction-focused tool with a general-purpose Simple/Advanced HAR viewer.

Built and refined across several rounds:
- Dual-mode viewer, virtualized rendering, drag-and-drop upload, error/empty states
- Advanced-mode column filters (Status/Method/Name/Model) with counts and Clear/Apply, inline
  accordion row expansion, full-text payload/response search with match highlighting and
  navigation, Excel export
- Bug fixes: transferred-size calculation (was using uncompressed content size), request-count
  safety net, speed-aware red/amber/green classification with a named threshold constant
- Custom per-API speed thresholds, API-wise cumulative time breakdown, Preflight detection and
  its own icon/color, filter-popover positioning (portal + Floating UI, escapes table overflow
  clipping, tracks the trigger icon correctly on scroll), GPT/model version detection across
  multiple key-naming conventions
- Branding strip, global time-unit spacing (`500 ms` not `500ms`), seconds as the default display
  unit
- Transferred-size now also checks the nonstandard `response._transferSize` field (Chrome's own
  authoritative wire-bytes figure) before falling back to uncompressed content size, and size
  formatting switched from binary (1024-based) to decimal (1000-based) units to match what
  Chrome DevTools' Network panel actually shows
- Filter popovers: fixed drift during scroll (a Floating UI positioning-strategy mismatch),
  smoother tracking via animation-frame-driven updates, and a `size`-middleware fix so the
  Clear/Apply footer never gets pushed off-screen in short browser windows

### v1.1 and earlier
The original vanilla-JavaScript tool (slide-number extraction for specific AI-pipeline APIs,
per-API optimal-time color coding, Excel export with legend). Superseded by the v2.0 rebuild above;
see git history for that implementation.

## Author

Built by **Naveen Rajkumar**

---

**Insights to Improve.** 🚀
