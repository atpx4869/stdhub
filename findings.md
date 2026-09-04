# Findings & Decisions

## Requirements
- Remove all in-app direct PDF rendering; use a single responsive paginated-image reader.
- Generate/reuse WebP pages in background after ingestion, with first-open fallback generation, partial availability, deduplication, recovery, invalidation, deletion, and cleanup.
- Preserve original PDFs and expose secure streaming inline-view and attachment-download endpoints with UTF-8 filenames and HTTP Range support.
- Prefer original BZ page JPEG assets when suitable; convert true PDF sources after ingestion.
- Lazy-load viewport-near pages, retain stable layout, limit memory, and support page tracking, zoom, fit width, fullscreen, retry, progress, navigation, view, and download.
- Handle encrypted/corrupt/oversized PDFs, missing converter, timeout, disk pressure, restart, races, deletion, special filenames, and reverse proxies without crashing the service.
- Install conversion dependencies in Docker with amd64/arm64 awareness and bounded concurrency/resources.
- Add backend/frontend/real-file tests, run builds and all tests, remove confirmed-unused legacy dependencies, and update project documentation/TODO/WORKLOG.

## Research Findings
- Repository cloned from https://github.com/atpx4869/stdhub on branch `main`.
- Backend is TypeScript/Express 5 with SQLite (`better-sqlite3`); frontend is non-module global JavaScript loaded in a fixed order and coordinated through `window._tabCleanup`.
- JSON routes must use the `{ data, error }` response envelope; streaming/static/file endpoints are explicit exceptions.
- Existing preview/download architecture shares a local PDF library indexed by `standard_files`, keyed around normalized code/year/source and absolute file paths.
- Current source semantics: BZ obtains per-page JPEGs and merges them through a two-worker `pdf-lib` pool; GBW/BY/Labr yield actual PDFs and enter the common library.
- Existing preview-task deduplication and the unified `StandardDownloadOrchestrator` already provide useful active-task/subscriber/cancellation primitives; current TODO states preview auto-download was recently migrated to that orchestrator.
- Legacy preview assets are extensive: desktop custom PDF.js (`public/vendor/pdf.min.mjs`, worker, `app-pdf-viewer.js`) plus mobile pdfh5 and about 5 MB of bundled CMaps/fonts/ICC/WASM.
- `sharp` is currently a devDependency even though Docker runtime installs `libvips42`; `pdfh5` is a production dependency. `pdf-lib` remains required for BZ PDF creation and cannot simply be removed.
- Docker is a two-stage `node:20-slim` image, non-root/read-only at runtime with persistent `/app/data` and `/app/standards`, and a 512 MB `/tmp` tmpfs. Conversion cache must live in a writable persistent mount, not `/tmp`.
- Architecture requires background task resources to be bounded and shutdown-aware. Existing PDF merge concurrency is 2; preview conversion should similarly default to low concurrency.
- Required docs warn not to disturb the currently suspended national-CMA boundary or unrelated qualification/search behavior.
- Existing `/api/preview/file/:id` already performs safe realpath validation, ETag handling, single-range streaming, and inline/attachment disposition. The new `/api/files/:id/pdf/view` and `/download` routes can share/refactor this proven streaming code.
- Current `preview-task-store` is in-memory and expires terminal tasks; it cannot satisfy restart recovery for image conversion without a persistent manifest/store.
- `library-index.ts` owns scan, watcher, add/move, missing-file cleanup, rename, and index updates. Preview cache hooks must be attached to all deletion/replacement/rename-relevant boundaries, not only one HTTP route.
- The existing desktop viewer renders every PDF page in the background despite a visible-first queue, while mobile uses pdfh5. This directly violates the new rule against initial full-document fetch/render and explains long-document memory pressure.
- Current file-library API exposes preview URLs as `/api/preview/file/:id` and attachment via a query flag; these front-end contracts need migration while compatibility may be retained for unrelated callers/tests.
- Existing PDF stream sets RFC 5987 UTF-8 filenames, `Accept-Ranges`, `206`, `416`, ETag, and streams with `createReadStream`; it is suitable as the common implementation for explicit view/download endpoints.
- Delete and batch-delete routes physically unlink then remove `standard_files`; the chokidar unlink handler also deletes index rows. Current scan full/incremental removal and missing-file paths likewise delete rows directly, so cache cleanup needs a reusable hook/service callable from all paths.
- Rename keeps the same database file ID, so an ID+content-hash cache key remains stable across cosmetic filename changes; no cache move is needed, only source-hash verification.
- `createApp` can be dependency-injected with `baseDir`, `dbPath`, and disabled background jobs for tests. The preview service should be instantiated there, started only with background jobs, exposed/closed through app lifecycle, and accept data/cache configuration based on `baseDir`.
- The current front-end has several preview entry paths (standard results, local library, source switching, and a pre-opened native popup flow). All should converge on one image-reader contract while keeping direct-anchor semantics for view/download buttons.
- The overlay markup is centralized in `public/index.html`, and `app-preview.js` owns cleanup. Replacing that module plus overlay markup/styles can remove both desktop and mobile renderer branches without changing unrelated result/file-library modules heavily.
- BZ already downloads every source JPEG into memory before `mergeJpegsToPdf`; those buffers remain available after the worker call because the merge helper transfers copies. Extending the internal export result with optional page-image buffers allows direct WebP reuse without re-parsing the generated PDF.
- `StandardDownloadOrchestrator` is the best handoff point after a PDF successfully enters the library, but manual files and watcher/scan updates also require a library lifecycle event so all ingestion paths enqueue conversion.
- Proposed converter pipeline: `pdfinfo` for page count/encryption diagnostics, then bounded per-page `pdftoppm -png -singlefile` followed by `sharp` WebP encoding. One-page-at-a-time output provides incremental availability and avoids loading an entire PDF or all raster pages in memory.
- `sharp` should move to production dependencies because runtime conversion and BZ JPEG reuse need it; Poppler (`pdfinfo`, `pdftoppm`) must be installed in the runtime image.
- The persistent manifest can be authoritative for generation state, keyed by numeric `standard_files.id`, and include source SHA-256, dimensions per page, progress, generator version, and normalized error codes/messages. Atomic temp-write/rename prevents half-written manifests/images.
- A low-concurrency in-process queue (default 1, configurable) plus one active job per file ID supports NAS safety. Startup turns `processing` into pending and requeues; manifest/source-hash comparison invalidates replacements.
- The optimization roadmap’s governing rules reinforce a single preview lifecycle owner, isolated app tests, shutdown cleanup, realpath boundaries, rate limits, non-root Docker writes, and no unrelated broad refactor.
- Historical preview plans recommended retaining pdfh5, but the user’s newer explicit requirement supersedes that: both pdfh5 and custom PDF.js rendering must now be removed after confirming no other references.
- The historical in-memory preview task is specifically documented as restart-volatile. Image generation therefore needs its own recoverable persistent queue/state; the existing auto-download task may remain focused on acquiring missing originals.

## Technical Decisions
| Decision | Rationale |
|----------|-----------|
| Keep `pdf-lib` | BZ source still needs it to preserve original merged PDFs. |
| Put persistent preview cache under the application data tree | Docker already mounts `/app/data`; `/tmp` is ephemeral and capped. |
| Reuse existing task/download/library mechanisms where practical | Minimizes regression risk and follows project architecture. |
| Refactor common PDF streaming instead of duplicating it | Existing safe-path, ETag, Range, and disposition behavior is mature and testable. |
| Persist image-generation state per cache key | In-memory preview tasks cannot recover after service restart. |
| Cache key uses database file ID and source content hash | Avoids unsafe filenames, survives renames, and automatically invalidates replaced content. |
| Keep legacy `/api/preview/file/:id` as a compatibility alias during migration | Other file-library/download code still calls it; explicit new endpoints can become the canonical contracts without breaking unrelated functionality. |
| Reuse BZ page buffers through an optional internal export field | Avoids JPEG → PDF → raster roundtrip while preserving the required original PDF. |
| Use Poppler plus sharp | Stable Docker packages, explicit licensing, incremental pages, and WebP output without PDF.js. |
| Keep auto-download acquisition and page-generation tasks separate | They have different keys, persistence needs, failure modes, and retry semantics; coupling them would complicate current source fallback behavior. |
| Use sharp 0.35.4 with its platform libvips | The initial 0.34.5 install inherited a high-severity 2026 libvips advisory; the upgraded production audit is clean. |

## Final Verification Findings
- No runtime PDF.js, pdfh5, custom `PDFViewer`, worker, or old viewer-script references remain under `public/`, `src/`, or production dependencies.
- The only remaining `/api/preview/file/:id` front-end calls are non-rendering legacy CRUD operations (reveal, rename, normalize, delete); all preview/view/download paths use the new contracts.
- BZ page bytes flow from the adapter through the unified download orchestrator into the library event without re-reading the merged PDF.
- The reader performs near-viewport loading, limits current-page layout work to observed-near elements, unloads distant images, and releases all per-reader resources on close/source switch.
- Local Docker and Poppler executables are unavailable, so the real image build/converter executable check must run in CI or deployment. Deterministic converter integration, 101-page image-native, API, Range, build, CSS, JavaScript, and full application tests pass locally.

## Issues Encountered
| Issue | Resolution |
|-------|------------|
| Initial attachment output used the wrong terminal encoding | Explicit UTF-8 will be used for subsequent reads. |
| PowerShell `rg public/css/*.css` failed because Windows did not expand the glob | Use `rg ... public/css` or `rg --glob '*.css' public/css` on the next inspection. |

## Resources
- User request attachment: `C:\Users\PengLinHao\.codex\attachments\ebfe4ce2-0da6-49ed-9d55-b20c99858080\pasted-text.txt`
- Upstream repository: https://github.com/atpx4869/stdhub

## Visual/Browser Findings
- Current app shell is a dark, blue-violet, glow-heavy utility UI with a dense left navigation on desktop and a four-item bottom navigation on mobile.
- The implemented reader duplicates hierarchy: the outer preview header already contains title/view/download actions, while the inner sticky toolbar repeats view/download and adds page/zoom/fullscreen controls.
- The separate source picker and permanently sticky generation-status row can create three stacked chrome bands above the document.
- Mobile correctly becomes full-screen, but uses `100vh` rather than `100dvh`, retains a second reader toolbar, and exposes actions through a small `<details>` popover rather than a touch-oriented action sheet.
- The fixed dark document canvas and white pages are directionally right, but theme overrides and blue-violet application chrome compete with the reading surface.
- The redesign should be a focused document mode: one toolbar, quiet charcoal canvas, white paper, one cobalt accent, restrained radii, and no decorative glow inside the reader.
- Recommended design dials: `DESIGN_VARIANCE 3`, `MOTION_INTENSITY 2`, `VISUAL_DENSITY 6`. This is a regulated/technical daily-use tool, not a marketing page.
- GSAP is not justified for the reader redesign. Native scrolling, IntersectionObserver, and short CSS transform/opacity transitions better protect responsiveness and reduced-motion behavior.
- Desktop should combine close/back, title/source, page count, zoom/fit, fullscreen, and overflow actions into one 52-56px toolbar. Generation progress should collapse to a thin contextual status strip and disappear when ready.
- Mobile should use one 52px app bar with back, truncated title, page count, and More; multi-source choice and secondary actions should live in a bottom sheet. Use `100dvh` plus safe-area padding.
- Accessibility gaps to address include dialog semantics, focus trapping/restoration, keyboard-visible focus, explicit menu state, and non-color status communication.

## UI Redesign Implementation Findings
- A single 56px document toolbar is sufficient for title, source, page position, scale, fullscreen, and original-file actions on desktop.
- At 700px and below, full-bleed pages and a bottom action sheet avoid cramped toolbar controls while retaining page position and document identity.
- The reader can remain framework-free: the existing observer/polling implementation supports the new chrome with a small public action surface and no animation dependency.
- Browser review found a breakpoint mismatch between CSS (640px) and JavaScript (700px); aligning both at 700px prevents scale width from changing unexpectedly on small tablets.

## Whole-Application UI Audit Findings
- The product has nine top-level surfaces: standard search, qualification search, CMA capability-library diff, local library, download history, tools, runtime logs, usage statistics, and settings, plus a mobile-only account hub.
- The current desktop shell uses a 240px sidebar and 52px top bar, but the main content lacks a consistent page-header and work-area rhythm across search, tables, dashboards, and settings.
- The existing visual language is dark blue-violet with bright glow treatments, emoji navigation, strong grid decoration, and many nested cards. It competes with the newly restrained document-reader mode.
- The search page has excessive empty canvas before results and makes the source toggles visually compete with the primary search action.
- There are at least 35 inline-style declarations in the main HTML and 45 emoji/glyph instances, indicating that responsive behavior and icon language are fragmented rather than governed by shared components.
- Preserve the current URL/tab names, primary navigation labels, form field names, and operational flows. The redesign should change hierarchy and presentation without rewriting the application architecture.
- Live audit shows page titles can visually collide with the persistent environment-warning band; the shell needs one authoritative vertical stack for top bar, notices, page header, and content.
- Tools currently presents a large generic card with the primary action detached in its header. Redesign it as a task workspace: instruction/input on the left, live validation and outcome on the right, with a shared mode switch.
- Qualification search repeats nearly the same search composition as standard search but with different spacing and tab chrome. Both should share a Search Workbench component while keeping domain-specific filters and result templates.
- Empty states consume most of the viewport without explaining next actions or sample queries. Each workflow needs contextual examples and a consistent empty/loading/error state family.
- CMA 一单一库 has the heaviest command surface: five page-level actions, three modes, advanced filters, diagnostics, blacklist, subscription, and sync states. It needs progressive disclosure and a persistent scope/status summary, not another generic card stack.
- The file library has the right table-first information architecture, but search, counts, selection, and destructive actions sit in one equally weighted row. Selection actions should appear contextually only after selection, and normal browsing controls should stay quiet.
- Both pages demonstrate excess glow and nested borders. The new visual system should use elevation only for overlays, with page structure defined by spacing, section bands, and sparse dividers.
- Runtime logs are the strongest candidate for a dense operations-console pattern. The existing two-column layout is sound, but status colors, filters, metrics, and quick filters repeat the same information; simplify to one filter rail, one query bar, and a virtualized event stream.
- Usage statistics currently treats empty charts as large blank cards and can show a misleading 100% success rate when total operations are zero. Empty datasets need an explicit no-data state, while populated views should emphasize trend and exceptions before secondary distributions.
- Numeric content should use the mono family consistently, while labels and prose use the primary sans family. Current typography hierarchy is too low-contrast and makes metrics, filters, and descriptions visually blend together.
- Settings contains six well-defined domains but the horizontal subsection navigation and long stacked content compete for vertical space. A stable two-column settings shell with a narrow local nav, concise section intro, and grouped field rows is a better fit.
- Settings controls are generally understandable, so this is an evolution rather than an interaction rewrite: preserve values, order, IDs, and save behavior while standardizing segmented controls, switches, source rows, and diagnostic states.
- Download history is structurally too thin for a standalone card inside a page. It should become a chronological activity table/list with date grouping, source/status filters, retry/open actions, and a purposeful empty state; destructive clearing belongs in an overflow menu.
- The mobile account hub already has an appropriate settings-list model, but repeats navigation and theme glyphs through emoji. Replace these with one coherent icon set and surface only role-relevant shortcuts.
- The global task center is correctly modeled as a right-side drawer, but its native select controls visibly fall outside the dark theme and the empty state is visually unfinished. It should share the same filter, row, progress, and empty-state primitives as history and logs.
- Responsive CSS is concentrated at a 640px breakpoint with many page-specific overrides. The redesign should establish shared breakpoints and primitives first, then remove page-local compensating rules instead of layering more overrides.

## Whole-Application Redesign Direction
- Design read: a standards/compliance operations workspace for frequent professional use, with a restrained industrial-document language and a custom native design system that preserves the existing vanilla frontend architecture.
- Dials: DESIGN_VARIANCE 4, MOTION_INTENSITY 3, VISUAL_DENSITY 7.
- Default dark theme uses charcoal/slate neutrals, one cobalt interaction accent, and semantic colors only for real success/warning/error states. Remove decorative purple glows and the background grid.
- Use a consistent 8px control radius and 10-12px structural radius; reserve shadows for drawers, menus, and dialogs.
- Use a single library-derived icon family instead of emoji. Keep current labels, routes, IDs, data contracts, permissions, and workflows.
- Use shared primitives for AppShell, PageHeader, SearchWorkbench, SegmentedTabs, FilterBar, DataTable, EmptyState, StatusBanner, Drawer, Dialog, SelectionBar, and SettingsRow.
- GSAP is optional and narrowly scoped to interruptible page/workspace transitions. If adopted, use matchMedia, autoAlpha/transform only, timeline cleanup on tab change, and a static reduced-motion path. No ScrollTrigger or decorative continuous motion.
- Implementation order: foundation and shell; search/qualification/CMA; library/history/tools; logs/statistics/settings/account; global overlays and states; motion/accessibility/performance QA.

## Cross-Device Development Findings
- Agent skill installation is machine-local and must not be assumed to travel with the Git repository.
- The repository therefore documents exact `npx skills add` commands and requires a Codex restart after installation.
- CodeGraph remains conditional on a repository-local `.codegraph/` directory; installing its skill does not authorize automatic indexing.
- The browser icon font is different from an agent skill: it is a locked npm dependency, and the required CSS/WOFF2 assets are vendored under `public/vendor/tabler-icons/` so deployed clients do not need network access.
- The user primarily works in Paper on newer computers and classic on older computers. Paper is now the first visual acceptance target, while classic is the Chrome 109 compatibility baseline; dark/light remain supported parity themes.

## Foundation Implementation Findings
- The existing classic theme replaced Emoji with BMP pseudo-elements using selectors that also override icon-font pseudo-elements. Tabler elements must bypass those legacy replacement selectors, while old non-Tabler markup keeps the BMP fallback during migration.
- The first classic browser reload used a cached `workspace.css` URL and showed missing-glyph squares. Bumping the stylesheet version confirmed the repaired selector and font override work correctly.
- Paper and classic now render the shared 216px desktop sidebar, 56px top bar, consistent Tabler navigation, flat content canvas, and unified control geometry.
- A 390px audit confirms the responsive shell and four-item bottom navigation work in both priority themes. The search page still has excessive vertical space between mode tabs and input on mobile; this belongs to Phase 12 search-workbench restructuring rather than the shell.
- Playwright is installed as a dependency but its bundled headless browser is not installed on this workstation. Visual capture succeeds by pointing Playwright at the locally installed Chrome executable, so downloading another browser is unnecessary.

## Search and Qualification Implementation Findings
- The mobile search gap came from an intentional legacy `25vh` idle-stage offset combined with hidden source/template controls. Reducing it to a bounded 9vh and showing the secondary controls creates a compact workbench without changing search-stage JavaScript.
- Standard search, qualification search, and CMA capability search can share hierarchy and control geometry while keeping their separate scripts and result renderers.
- Paper desktop checks show the new search page title, compact mode switch, single-line search workbench, and contextual examples read as one workflow instead of disconnected cards.
- At 390px the search input, action, source controls, templates, and bottom navigation now fit without the former empty vertical gulf.
- Qualification now uses an explicit work area with a purposeful empty state and no fixed viewport-height trap. CMA now exposes synchronization as the primary action and moves diagnostics, export, blacklist, and cleanup into a secondary menu without changing their IDs or handlers.
