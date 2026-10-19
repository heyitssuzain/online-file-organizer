# AuraFlow Web

> **Your Files. Finally Organized.** — a fast, privacy-first file organizer that runs
> entirely in your browser. No uploads. No accounts. No cost.

AuraFlow Web is the browser edition of [AuraFlow — File Organiser](https://github.com/heyitssuzain/File-Organiser)
(a free Windows desktop app). It ports the desktop's proven categorization engine —
the same category lists, collision-renaming rules and exclusion filters — into a
static website that works on any OS with a modern browser.

---

## Features

- **File categorization** — 11 categories (Documents, Images, Videos, Audio, Archives,
  Code, Executables, Design & 3D, Fonts, Data, Others) with case-insensitive extension
  matching. Unknown extensions flow into *Others* — nothing is discarded.
- **Three organizing rules** — by type, by extension, or by month (last-modified date).
- **Plan preview** — every file → category → destination is visible *before* anything
  moves. Confirmed execution only.
- **Conflict-safe naming** — never overwrites. Collisions get `name_1.ext` renames
  (port of the desktop `safe_move`), checked against the plan *and* existing folder
  contents.
- **Batch processing** — up to 5,000 files with per-category stats, skipped-file
  accounting (temp/system/pattern) and unknown-extension flags.
- **Duplicate detection** — content-based: group by exact size, SHA-256 verified,
  streamed in 4 MB slices. Name matches are never treated as duplicates.
- **Manual download** — a safe fallback for plan organization is downloading a ZIP file bundle in category folder structure as well as JSON/CSV manifests.
- **Manifests & reports** — every plan and executed run exports as JSON, CSV or TXT.
- **Undo** — one-click reversal of the last executed run while the tab is open
  (File System Access API browsers).
- **Theme** — dark (charcoal) and light (warm off-white), system-aware + manual toggle.
- **Accessible** — semantic HTML, keyboard navigation, `prefers-reduced-motion`
  support, live regions for operation status.

## What it deliberately does *not* do

Honest list (matches the implementation):

- **No background watching** — browsers cannot monitor folders silently.
- **No uploads** — there is no backend at all; all processing is in-tab JavaScript.
- **No folder writes in Firefox/Safari/mobile** — those get the organized-ZIP path.
- ** Depths** — recursive scans are capped (3 levels via folder permission, 5,000 files).
- **ZIP fallback is uncompressed** and capped at 2 GB of selected files.
- **Undo is tab-session scoped** — the manifest remains as a manual fallback.

## Technology stack

| Layer | Choice | Why |
|---|---|---|
| Build | Vite 6 (multi-page) | Lean static output, zero-cost hosting |
| Language | TypeScript (strict) | correctness for the file-ops logic |
| Framework | none (vanilla TS + DOM) | no SPA overhead; crawlable static pages |
| Styling | hand-rolled CSS design system | no CSS framework dependency |
| 3D hero | CSS 3D transforms | quality without a WebGL library |
| Hashing | incremental SHA-256 in a Web Worker | flat memory, non-blocking UI |
| ZIP writer | ~200-line stored-ZIP module | fallback without any dependency |
| Tests | Vitest | fast, Node-side core-logic tests |

Total runtime dependencies: **0**.

## Installation & development

```bash
git clone <repo-url> File-Organizer-Web
cd File-Organizer-Web
npm install
npm run dev        # http://localhost:5173/File-Organizer-Web/
```

## Testing

```bash
npm test           # 56 unit tests (core logic)
npm run typecheck  # tsc --noEmit (strict)
npm run build      # production build (also runs typecheck)
```

Test coverage (see `tests/`):

- Extension normalization & case-insensitivity, unknown types, temp/system/pattern rules
- Category rule parity with the desktop lists
- Plan building: grouping, three rules, category filters, exclusions, empty selections
- Collision handling: in-plan renames, `_1/_2` chains, disk-existing collisions, sanitization
- Incremental SHA-256 against Node's `crypto` (incl. boundary sizes 55/56/63/64/65)
- Duplicate grouping semantics (content-equal only)
- CRC-32 (`crc32 == node:zlib.crc32`) and ZIP structure checks (signatures, sizes)
- Manifest rows/text report; CSV escaping

## Build & deployment (GitHub Pages, ₹0)

```bash
npm run build                 # outputs dist/ (+ sitemap.xml, robots.txt)
```

Then either:

- **GitHub Actions**: push `dist/` to the `gh-pages` branch, or
- **Upload `dist/`** to any static host (Netlify/Cloudflare Pages free tiers work).

The Vite `BASE` (default `/File-Organizer-Web/`) matches GitHub Pages *project* sites.
For a custom domain, copy `.env.example` → `.env`, set:

```
BASE=/
CANONICAL_BASE_URL=https://your-domain.example/
```

and rebuild. Canonical URLs, Open Graph URLs, `sitemap.xml` and `robots.txt` all
derive from `CANONICAL_BASE_URL` at build time.

**Post-launch SEO checklist** (manual steps, not automatic):

1. Verify the site in Google Search Console (DNS or file verification).
2. Submit `sitemap.xml`.
3. Confirm Search Console's "Page indexing" report sits cleanly.
4. Add Lighthouse "SEO" audits to your pre-release checklist (all pages ship
   unique titles/descriptions/canonicals — the build asserts nothing extra).
5. Performance: run `vite preview` + Lighthouse (mobile) before merging �
 the bundles stay lean by construction (no framework, no 3D lib).
6. Structured data (WebSite / SoftwareApplication / Article / BreadcrumbList)
   is already embedded per page; validate in the Rich Results test.

## Browser compatibility

| Capability | Chrome / Edge / Opera / Brave | Firefox | Safari | Mobile |
|---|---|---|---|---|
| Read files/folders | ✓ | ✓ | ✓ | ✓ files |
| Plan preview, manifests, duplicates | ✓ | ✓ | ✓ | ✓ |
| Organized ZIP fallback | ✓ | ✓ | ✓ | ✓ |
| Sort into a real folder + undo | ✓ (permissioned) | ✗ → ZIP | ✗ → ZIP | ✗ → ZIP |
| Folder background watching | not possible in any browser | | | |

## Privacy behavior

- Nothing is uploaded — there is no server-side component for organizing.
- All analysis, previews, hashing and packaging run locally in the tab.
- Folder writes happen only after the browser's explicit read/write prompt.
- No analytics, no cookies, no third-party requests.
- Only local persistence: your light/dark theme (localStorage).
- See [/privacy.html](https://heyitssuzain.github.io/File-Organizer-Web/privacy.html) — claims there map 1:1 to implementation facts.

## Known limitations

- Last-modified dates only (no true creation dates or EXIF-era metadata).
- Very large libraries: 5,000-file selection cap, 512 MB hashing cap, 2 GB ZIP cap.
- Undo ends with the tab session (manifest covers the rest).
- Firefox/Safari and all mobile browsers cannot write folders directly (platform).
- The app cannot verify img/video *contents* — extensions are hints (by design).

## Project layout

```
File-Organizer-Web/
├── index.html                 # home (hero + live demo + categories + FAQ)
├── organizer.html             # the working application
├── features.html / privacy.html / guide.html / about.html
├── guides/                    # 5 original guide articles + hub
├── 404.html
├── public/                    # favicon.svg, og-cover.png
├── src/
│   ├── core/                  # pure logic (tested): categories, plan, naming,
│   │                          # sha256, hash, manifest, export, zip
│   ├── fs/                    # File System Access layer + execute/undo ops
│   ├── workers/hash-worker.ts # WASM-free streaming hash worker
│   ├── site/layout.ts         # header/footer/theme chrome
│   ├── hero/hero.ts           # CSS-3D interactive hero
│   ├── styles/                # tokens / base / site / hero design system
│   └── pages/                 # per-page controllers
├── tests/                     # Vitest suites (56 tests)
└── vite.config.ts             # MPA inputs, base URL, SEO file generation
```

## License

MIT — matching the desktop project. Qt/PySide (desktop exe) notices stay in the
original repository.
