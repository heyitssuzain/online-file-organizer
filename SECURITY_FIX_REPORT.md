# Security & Privacy Fix Report — AuraFlow Web

**Scope:** `File-Organizer-Web/` only. The original desktop project (`enhanced-organizer/`, `AuraFlow.exe`) was **not** touched — verified by `git status --short` at the end of this wave; the only parent-repo entries (`File Organiser.py` deletion + untracked `File Organiserr.py`) pre-date this work and were left exactly as found.

**Before this wave, all security checks were NOT green.** Initial `npm audit` reported **7 vulnerabilities (2 critical, 2 high, 3 moderate)**, and code review found DOM/XSS injection sinks plus CSV formula injection. All confirmed findings below were actually fixed and re-verified. Nothing is claimed "secure" beyond what the evidence shows.

---

## 1. File-operation & data-flow trace (verified from source, not assumed)

Every path was followed in `src/`:

| Stage | File | Network? | Storage? | Outcome |
|---|---|---|---|---|
| User picks files / folder / drops | `src/fs/access.ts` (File input, `showDirectoryPicker`, DataTransfer) | ❌ none | ❌ none | `File` handles stay in memory |
| Planning | `src/core/plan.ts` (classification only — name, size, extension, mtime) | ❌ none | ❌ none | plan preview in DOM |
| Duplicate check | `src/core/hash.ts` + `src/core/sha256.ts` (streamed 4 MB slices) | ❌ none | ❌ none | hashes in a JS `Map` only |
| Execute (Chromium) | `src/fs/operations.ts` (`FileSystemFileHandle.move`) | ❌ none | ❌ | writes only inside the **user-granted** directory handle |
| Execute (fallback) | `src/core/zip.ts` (stored, streaming CRC) → blob download | ❌ none | ❌ | ZIP download only |
| Manifests / plan CSV / report | `src/core/export.ts` → `a.download` blob | ❌ none | ❌ | downloads only |

**Network surface of the shipped bundle (grep evidence over `dist/assets/*.js,*.css`):**
- `fetch(` appears **once** — Vite's built-in modulepreload polyfill (`credentials:"same-origin"`, same-origin asset URLs only). No user data flows through it.
- Zero occurrences of `XMLHttpRequest`, `sendBeacon`, `WebSocket`, `document.cookie`, `indexedDB`, `EventSource`.
- No analytics, no third-party scripts, no fonts/CDNs (system fonts), no images beyond self-hosted `favicon.svg`/`og-cover.png`.
- **File contents and filenames never leave the browser.** Downloads (`CSV/JSON/TXT/ZIP`) are the only outbound artifacts, and they go to the user's own download folder.

**Storage:** `localStorage` has exactly one key, `"auraflow-theme"` (`src/site/layout.ts`) — a non-sensitive UI preference. No cookies are set; nothing is persisted about files, paths, or plans.

**Permissions model:** the app can only write where the user explicitly grants `showDirectoryPicker`; there is no `showSaveFilePicker`/arbitrary-handle caching that survives reload, no attempt to reach paths outside the granted root. The web app fundamentally cannot touch the user's filesystem beyond what the File System Access API grants.

---

## 2. Confirmed vulnerabilities → fixes (all applied)

### 2.1 DOM XSS via filename → plan preview (`HIGH`, fixed)
- **Location:** `src/pages/organizer.ts`, `planFolderLabel()` interpolating the raw file extension into `innerHTML` (old line 253 usable from a filename like `a.<img src=x onerror=…>`, since `normalizeExtension()` = "everything after the last dot").
- **Impact:** self-XSS in the preview; defense-in-depth still required because filenames are attacker-controllable text in any real workflow.
- **Root cause:** extension text was treated as trusted data in an HTML sink.
- **Fix:** (a) extension-derived folder names are now sanitized once at the source — see 2.2; (b) `planFolderLabel()` now reads the sanitized `entry.destination` and is HTML-escaped at the render site (`escapeHtml`).
- **Files:** `src/core/plan.ts`, `src/pages/organizer.ts`.
- **Regression tests:** `tests/security.test.ts` — 5 hostile filenames driven through the full plan → every destination segment asserted free of `<>"\/\\` and control characters.

### 2.2 Unsanitized folder path from user extension (folder-write + ZIP + manifest) (`MEDIUM`, fixed)
- **Location:** `src/core/plan.ts` `foldersFor()` — under the `extension` rule the destination folder was the raw `extension.slice(1)`, used verbatim for: the plan preview, ZIP entry paths (`buildZip`), real directory creation (`getDirectory(create:true)` in `src/fs/operations.ts`), and manifests.
- **Impact:** hostile folder names (`<>:"|?*`, leading/trailing dots, `..`-like segments) reaching filesystem paths on non-Windows browsers, and Windows-invalid names.
- **Root cause:** filenames were sanitized for the *file name* (`displayMoveName`) but not for the *derived folder*.
- **Fix:** new `extFolderName()` — extension body lowercased, truncated to 64 chars, passed through `sanitizeFilename()`, with `no-extension` fallback and leading-dot guard (kills `..` path tricks).
- **File:** `src/core/plan.ts`.

### 2.3 DOM XSS via filename on the home demo (`HIGH`, fixed)
- **Location:** `src/pages/home.ts` demo rows — `files.slice(0,3).map(f => f.name).join(', ')` interpolated into `innerHTML` unescaped.
- **Fix:** each name is passed through the file's existing `escapeHtml()`.
- **File:** `src/pages/home.ts`.

### 2.4 CSV formula injection (`LOW`, fixed)
- **Location:** `src/core/export.ts` `csvEscape()` — plan/manifest CSVs contain user filenames; a cell starting `=` `+` `-` `@` `\t` `\r` can execute as a formula when opened in Excel/LibreOffice (OWASP guidance).
- **Fix:** a literal apostrophe is prefixed to such cells before standard CSV quoting.
- **Regression tests:** 4 `dangerous` payloads asserted prefixed; plain names and normal quoting asserted unchanged.

### 2.5 Missing Content-Security-Policy & security headers (`MEDIUM` for production, fixed)
- **Fix:** added **`vercel.json`** for the Vercel deployment target:
  - `Content-Security-Policy`: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' (inline style attributes are used throughout the existing UI — required); img-src 'self' data:; font-src 'self'; connect-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'; upgrade-insecure-requests`
  - `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, restrictive `Permissions-Policy` (camera/mic/geo/payment/usb disabled), `Cross-Origin-Opener-Policy: same-origin`, HSTS.
- **Compatibility check:** all app scripts are external module bundles (`script-src 'self'` ✓); JSON-LD blocks (`application/ld+json`) are data blocks, not executable, and remain allowed; no inline event handlers exist in any page; inline `style=` attributes are covered by `style-src 'unsafe-inline'`; blob URIs are only used behind download-anchors (not blocked by any directive).
- **Limitation (documented, not fixable):** GitHub Pages cannot set response headers; if that deployment target is ever used again, the CSP only exists via `vercel.json`. No meta CSP was injected on purpose — a restrictive meta tag would have broken `vite dev` (inline HMR) and given a false sense of coverage.

### 2.6 Vulnerable dependencies — 7 findings (2 critical, 2 high, 3 moderate) (`dev-only`, **fixed**)
- **Before:** `vitest@2.1.9` chain — `tinypool` (critical: prototype-pollution RCE gadget), `vitest` (critical: arbitrary file read via mocker/UI server; path traversal), `@vitest/mocker`, `vite-node`, nested esbuild dev-server request-read, nested vite path traversal; plus `playwright@1.49.1` (high: browser download without SSL certificate verification).
- **Root cause:** devDependencies pinned during the original scaffold.
- **Assessment:** *dev-only* — none of these packages are in the shipped bundle (the app has **zero production dependencies**; verified against `package.json`). Risk was limited to developer machines running tests/dev server under an attacker-controlled page. Still fixed rather than waived.
- **Fix:** `vitest ^2.1.0 → ^5.0.5` and `playwright ^1.49.1 → ^1.55.1` — **after: `npm audit` reports 0 vulnerabilities.** Lockfile regenerated by these two targeted upgrades only; package manager unchanged; no other dependency touched (vite stays 6.4.x, typescript unchanged).

### 2.7 Honesty fix (minor)
- `organizer.ts` hashing status string "streamed, wrong-progress-proof" was nonsense wording; corrected to "streamed in 4 MB chunks".

---

## 3. Verified safe (no change made — inspection only)

- **hero.ts `innerHTML`** — all interpolated values are compile-time constants (`FILES`, `FOLDERS`, category colors); no user data reaches these sinks.
- **organizer file list** — names/paths inserted via `textContent` (inherently safe); row `title=` attributes escaped.
- **results table / duplicate groups / skip notes** — every user-derived string escaped via `escapeHtml()` at insertion.
- **ZIP entries** — paths built from sanitized segment(s) (2.2) + `displayMoveName`; slash/backslash stripped by `sanitizeFilename`, so no path traversal inside archives.
- **No `eval`, `new Function`, `setTimeout(string)` anywhere in `src/`.**
- **`hash-worker.ts`** — currently never spawned (hashing runs on the main thread with incremental streaming; the doc comment in `hash.ts` describing the worker is stale). Informational only; kept under CSP discipline (`worker-src 'self'`) so wiring it later stays allowed. Dead code, attack surface zero.
- **Uploads** — none. Form submissions: none (`form-action 'none'` is compatible).

---

## 4. Tests & build results (after fixes)

| Check | Result |
|---|---|
| `npm test` (vitest 5) | **64/64 passed** — 56 pre-existing + 8 new security regression tests (`tests/security.test.ts`) |
| `npx tsc --noEmit` | clean |
| `npm run build` (production) | ✓ built, sitemap.xml + robots.txt regenerated |
| `npm audit` | **0 vulnerabilities** (was 7) |
| Shipped-bundle grep (`dist/assets/*.js`) | no `XMLHttpRequest`/`sendBeacon`/`WebSocket`/`cookie`/`indexedDB`; single same-origin `fetch` = Vite modulepreload polyfill |

## 5. Why these fixes don't break existing features

- `extFolderName()` only changes `extension`-rule folder names (previously arbitrary user text; now portable names). Type/date rules untouched; collision resolution untouched (4.2's "type rule unaffected" test asserts `a.pdf → a_1.pdf` still works).
- All UI HTML/layout/animations/SEO untouched — fixes are data-hygiene at insertion points.
- Vitest upgrade touched the test runner only; all 56 pre-existing tests pass unchanged.
- Playwright upgrade affects the (currently optional) smoke-test script only; on next use it will fetch its newer browser build once via `npx playwright install chromium` (~120 MB, developer action, not part of deployment).

## 6. Remaining risks / manual actions (stated honestly — the app is not "certified secure")

1. **GitHub Pages header limitation** — headers ship via `vercel.json` for Vercel; GH Pages cannot serve them.
2. **Playwright browser build** — after the 1.55.1 bump, run `npx playwright install chromium` once before re-running `scripts/smoke.mjs` (browser tests for this wave were not rerun; unit + build coverage green).
3. **Self-XSS residual** — even with escaping everywhere, users can still harm themselves with garbage filenames in any web app; treated as mitigated at sink level.
4. **CSV apostrophe prefix** is the OWASP compromise: if a customer renames such files via spreadsheets, a leading `'` would appear. Documented behavior, considered acceptable.
5. **Trailing-slash/clean URLs on Vercel** — `/guides/` works as directory index; `.html` links preserved via canonical tags. Not verified on live Vercel yet — verify post-deploy.
6. **Unrelated uncommitted parent-repo changes** (`File Organiser.py` deletion / `File Organiserr.py` addition) pre-date this project and were deliberately left alone — please review/commit them yourself if intentional (Rule: never disturb unrelated user work).

## 7. Deployment status

- ✅ Code-level scope: verifies local-only processing, no network exfiltration, sanitized rendering, sanitized destinations, no secrets in bundles or repo (`.env.example` contains only `BASE` / `CANONICAL_BASE_URL`, no real credentials anywhere).
- ❌ **Not deployed.** Public deployment must wait for your explicit go-ahead; before going live, deploy once to a Vercel preview and confirm the CSP header appears on responses (`curl -I`), then promote.
