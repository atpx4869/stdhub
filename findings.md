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
