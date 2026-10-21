# AuraFlow Web

> **Your files. Finally organized.** A privacy-first file toolkit that runs entirely in your browser:
> organize folders, convert images and documents, build PDFs from images, and merge PDFs.
> No uploads, no accounts, no server-side copy.

AuraFlow Web is the browser edition of [AuraFlow — File Organiser](https://github.com/heyitssuzain/File-Organiser)
(a free Windows desktop app). It brings the desktop's categorization engine and a set of focused,
local file tools to any operating system with a modern browser.

---

## The toolkit

| Tool | What it does | Runs where |
|---|---|---|
| **Organizer** (`organizer.html`) | Categorizes files by type, extension or modified month; previews every destination; detects duplicates; moves/copies into a real folder where the browser allows it, or builds an organized ZIP | Tab + Web Worker for SHA-256 |
| **File Converter** (`converter.html`) | Converts images, text documents and tabular data; per-file output choice; individual downloads or one ZIP | Tab (Canvas) for images/text; Web Worker for PDF merging is not used here |
| **Image → PDF** (`image-to-pdf.html`) | Combines images into a real PDF with previews, reorder, rotation, A4/Letter/original pages, orientation, fit, margins and resolution | Canvas in the tab; pdf-lib in a dedicated Web Worker |
| **PDF Merger** (`pdf-merger.html`) | Combines PDFs in queue order without rasterizing pages; reads page counts locally | pdf-lib in a dedicated Web Worker |

There is no backend that receives files. Everything is decoded, converted and packaged in memory in
the browser tab. The only local persistence is the light/dark theme choice.

## Supported formats

### File Converter

| Input | Detected as | Outputs |
|---|---|---|
| PNG, JPG/JPEG, WebP, BMP, GIF, SVG, AVIF, browser-decodable ICO | Image | PNG, JPG/JPEG, WebP, BMP |
| TXT, MD/Markdown, HTML/HTM | Text | PDF, HTML, MD, TXT — never the same source format |
| CSV, TSV, JSON | Data | CSV, JSON, XLSX |

Important details:

- A same-format image conversion with no requested resize is passed through byte-for-byte.
- Every other image is re-encoded through Canvas. GIFs become their first frame. SVG is rendered by
  the browser at its natural size. Animated AVIF/WebP do not preserve animation.
- JPEG and WebP quality is adjustable (50–100%). PNG stays lossless. BMP is uncompressed.
- HTML → PDF extracts readable text. It does **not** render the HTML page layout, CSS or images.
- Markdown → PDF supports headings, paragraphs, lists, quotes, code blocks and horizontal rules.
- Text PDFs use a bundled Noto Sans subset. It covers Latin, Greek, Cyrillic and common punctuation.
  **CJK characters and emoji are not in the font**; conversion fails with the exact missing characters
  instead of producing blank glyphs. Export those files as HTML/TXT if you need the original characters.
- CSV/TSV parsing handles quoted commas, embedded newlines, doubled quotes, UTF-8 BOMs and automatic
  comma/tab/semicolon detection.
- XLSX is **output-only** and written locally. Strings are inline strings, so cells beginning with `=`
  are data, not formulas. CSV export also neutralizes formula-leading cells.
- Limits: 50 files, 150 MB per file, 300 MB per batch, 50,000 data rows, 300 columns, 8 MB text input,
  20 MB data input. Larger inputs are rejected with a message rather than partially processed silently.

### Image → PDF

- Input: PNG, JPG/JPEG, WebP, BMP, GIF (first frame), SVG, AVIF and other browser-decodable images.
- One image per page, in the visible queue order (drag the handle or use the up/down buttons).
- Rotate in 90° steps. Page size A4, US Letter or the original image size. Auto/portrait/landscape
  orientation. Fit-inside or fill-page (crop) placement. 0/10/20/30 mm margins. Optional downscaling
  to 3200/2200/1200 px.
- Images are normalized through Canvas before embedding. This applies EXIF orientation and avoids a
  known pdf-lib hang on malformed-but-decodable PNGs.
- JPEG sources remain JPEG at high quality; other sources become PNG so transparency is preserved.
- Limits: 75 images, 250 MB per batch.
- Every page is an image. Text inside a photo is not selectable and no OCR is performed.

### PDF Merger

- Input: PDF only. Up to 40 files / 300 MB per batch.
- Pages are copied with pdf-lib, not rasterized. Page order, page dimensions, selectable text, fonts and
  vector artwork survive. Document outlines/bookmarks, AcroForm fields, embedded files and rare
  annotation types are not guaranteed.
- Encrypted/password-protected PDFs are rejected with a clear message. AuraFlow never asks for a password.
- Invalid files are rejected when they enter the queue and block merging.
- Page counts are read locally before you merge.

## Organizer

- **11 categories** — Documents, Images, Videos, Audio, Archives, Code, Executables, Design & 3D,
  Fonts, Data and Others — using the same extension lists as the desktop app. Extensions are
  case-insensitive; unknown extensions go to **Others**.
- **Three rules** — by type, by extension, or by modified month (`YYYY-MM/`).
- **Preview first** — every file, category and destination is visible before anything changes. Nothing
  is deleted, overwritten or moved without confirmation.
- **Conflict-safe naming** — collisions get `name_1.ext`; existing folder contents are checked before a
  real-folder run. No overwrites.
- **Duplicate detection** — exact size first, then SHA-256 streamed in 4 MB slices inside a Web Worker.
  Files are never called duplicates just because their names match.
- **Two honest execution modes** — direct folder moves in Chromium (File System Access API, explicit
  read/write permission) with in-tab undo for folder-picked runs; organized ZIP fallback elsewhere.
- **Explicit Move / Copy** — individually selected files are copy-only; moving them is blocked because
  the browser does not expose their parent folder. Folder-picked moves remain undoable.
- **Manifests** — JSON, CSV and TXT exports for every plan and completed run.
- **Limits** — 5,000 files, 3-level folder reads, 512 MB per file for duplicate hashing, 2 GB ZIP.

## Privacy guarantees

- **No file uploads.** There is no backend that could receive file data. DevTools → Network shows only
  same-origin assets.
- **No file contents, names, conversion queues or histories in localStorage, sessionStorage,
  IndexedDB or cookies.** Reloading or closing the tab clears them. The theme preference is the only
  local storage key.
- **No analytics, fingerprinting, accounts, sign-in or tracking cookies.**
- **No file names or metadata are transmitted.** The bundled PDF font is fetched from the same origin.
- **PDFs are treated as data.** They are parsed by pdf-lib, never executed.
- **Generated HTML is sanitized.** Remote assets are not embedded; links are restricted to safe
  schemes; the document is marked `noindex`.
- **Object URLs are temporary.** Image previews are revoked when an image is removed or the page is
  left; generated downloads are revoked after the download starts.
- **Workers receive only the bytes needed for the current job.** The PDF worker is created lazily and
  terminated when the page is left. No worker writes to storage.

The privacy page (`privacy.html`) maps each claim to the implementation.

## What it deliberately does not do

- No audio or video conversion. No reliable, fully local converter is bundled, so those formats are
  not advertised.
- No OCR, handwriting recognition or searchable-image PDFs.
- No cloud storage, synchronization, accounts or background folder watching.
- No direct folder writes in Firefox, Safari or mobile browsers; those get the organized ZIP path.
- No recursive folder writes. Folder scans are capped at 3 levels.
- No guarantee that PDF bookmarks/forms/embedded files survive merging.
- No claim that arbitrary image or text formats are supported just because the browser can preview them.

## Browser support

| Capability | Chrome / Edge / Opera / Brave | Firefox | Safari | Mobile |
|---|---|---|---|---|
| Organizer planning, duplicates, manifests | Yes | Yes | Yes | Yes |
| Organized ZIP fallback | Yes | Yes | Yes | Yes |
| Direct folder moves + undo | Yes (permissioned) | ZIP | ZIP | ZIP |
| File Converter | Yes | Yes | Yes | Yes |
| Image → PDF / PDF Merger | Yes | Yes | Yes | Yes |
| PDF worker (`worker-src 'self'`) | Yes | Yes | Yes | Yes |

Chromium refuses whole-folder picks for the Downloads/Documents roots with the generic message
“Cannot open this folder because it contains system files.” Select the files inside, pick a subfolder,
or drag files in instead. Individually selected files can be moved but not undone because their parent
folder is not exposed.

## Technology

| Layer | Choice |
|---|---|
| Build | Vite 6 multi-page build |
| Language | TypeScript, strict |
| Framework | None — vanilla TS + DOM |
| Styling | Hand-written CSS design system |
| Organizer hashing | Incremental SHA-256 in a Web Worker |
| PDF creation/merge | `pdf-lib` (lazy-loaded dynamic chunk) |
| Text PDF fonts | `@pdf-lib/fontkit` + bundled Noto Sans (OFL) |
| Images | Browser Canvas + `createImageBitmap` |
| XLSX writer | Small local OOXML/ZIP writer (no spreadsheet dependency) |
| Unit tests | Vitest |
| Browser tests | Playwright (headless Chromium or system Edge) |

## Development

```bash
npm install
npm run dev        # http://localhost:5173/File-Organizer-Web/
npm run typecheck  # strict TypeScript check
npm test           # unit tests
npm run build      # production build + unit typecheck
npm run preview    # serve dist/
```

The default base is `/File-Organizer-Web/` for GitHub Pages project sites. For Vercel or a custom
domain, create `.env`:

```
BASE=/
CANONICAL_BASE_URL=https://online-file-organizer.vercel.app/
```

Then rebuild. Canonical URLs, Open Graph URLs, `sitemap.xml` and `robots.txt` derive from
`CANONICAL_BASE_URL`.

## Testing

### Unit tests

```bash
npm test
```

Current coverage (116 tests) includes:

- Extension/category normalization and the three organizing rules
- Plan building, collision handling and hostile filenames
- Incremental SHA-256 against Node's crypto
- Duplicate grouping
- CRC-32 and stored-ZIP structure
- Manifest JSON/CSV/TXT output
- File formats and the supported-output matrix
- CSV/TSV/JSON parsing, formula-safe CSV, inline-string XLSX structure
- Markdown/HTML/TXT conversion, sanitization and entity decoding
- Image page geometry: A4/Letter/original, orientation, contain/cover, rotation, margin clamping
- Real PDF creation: image pages, text pages, pagination and missing-glyph rejection
- PDF merging: order, page sizes, metadata and invalid files

### Browser tests

The browser suites run against the real production build:

```bash
npm run build
npm run preview -- --port 4173
# in another terminal:
node scripts/tools-test.mjs
node scripts/smoke.mjs
```

`scripts/tools-test.mjs` currently performs 31 checks covering image outputs (PNG/JPEG/WebP/BMP) and
advertised image inputs (GIF/SVG/AVIF/ICO), text→PDF (including Latin/Greek/Cyrillic), unsupported
CJK/emoji rejection, CSV→XLSX, mixed batches, ZIP export, image-to-PDF order/original/Letter sizes,
corrupt-image rejection, PDF page counts, merge order, invalid and encrypted PDFs, Web Worker use,
unsupported-file notices, no console errors, no external requests and no persisted file data. It writes
downloadable artifacts to `artifacts/tools-test/` for inspection.

`scripts/smoke.mjs` covers all 17 public pages, the organizer workflow, toolkit accessibility names,
responsive layouts, reduced motion, 404 handling, deployment CSP/redirects and SEO metadata — 42 checks.

### Manual checks after deployment

- Deployed CSP allows same-origin workers, `blob:` image previews and the bundled font:
  `worker-src 'self' blob:`, `img-src 'self' data: blob:`, `font-src 'self'`.
- Test with a real JPEG from a phone (EXIF orientation), a transparent PNG, a multi-page PDF and a
  password-protected PDF.
- Confirm DevTools Network shows no third-party requests and no upload of file bytes.
- Confirm Downloads/Documents root-folder limitations still show the honest notice.

## Project layout

```
File-Organizer-Web/
├─ index.html                    # home: toolkit, demo, categories, FAQ
├─ organizer.html                # organizer application
├─ converter.html                # local file converter
├─ image-to-pdf.html             # image → PDF builder
├─ pdf-merger.html               # PDF merge queue
├─ features.html / privacy.html / terms.html / guide.html / about.html / contact.html
├─ guides/                       # guide hub + 5 guide articles
├─ 404.html
├─ public/
│  ├─ favicon.svg / og-cover.png
│  └─ fonts/NotoSans-Regular.ttf + OFL.txt
├─ src/
│  ├─ core/                      # pure, tested logic: categories, plan, naming, hashes,
│  │                             # manifests, export, ZIP, file kinds, data/text conversion,
│  │                             # PDF creation/merge geometry
│  ├─ browser/                   # Canvas image engine (convert, BMP, PDF preparation)
│  ├─ fs/                        # File System Access layer + execute/undo operations
│  ├─ workers/                   # streaming SHA-256 worker + pdf-lib worker
│  ├─ site/layout.ts             # header/footer/theme chrome
│  ├─ hero/hero.ts               # CSS-3D interactive hero
│  ├─ pages/                     # per-page controllers and shared tool UI
│  └─ styles/                    # tokens / base / site / hero design system
├─ scripts/                      # Playwright browser suites
├─ tests/                        # Vitest suites
├─ vercel.json                   # redirects + security headers/CSP
└─ vite.config.ts                # MPA inputs, base URL, SEO files
```

## Known issues and limitations

- Browser memory is finite. Very large images, 75-image batches or heavy PDFs can still exhaust a tab;
  use the resolution presets or split the batch.
- Cancelling during PDF assembly is disabled honestly: the worker finishes the document instead of
  pretending to stop mid-operation. Cancel remains available while images/PDFs are being prepared/read.
- `pdf-lib` does not guarantee preservation of outlines, forms, embedded files or every annotation type.
- Text PDFs are limited to the glyphs in Noto Sans Regular. CJK and emoji are rejected with details.
- XLSX output is deliberately one-way. It does not read `.xlsx` files.
- The organizer does not read file contents to classify; extensions are hints, not proof.
- Direct moves of individually selected files cannot be undone because browsers do not expose the
  parent directory handle.
- The site has no service worker and does not claim offline installation. Once loaded, the current tab
  continues to work without network access for already-loaded code and fonts.

## Deployment

### Vercel

Use the production repository and set:

```
BASE=/
CANONICAL_BASE_URL=https://online-file-organizer.vercel.app/
```

Build command: `npm run build`. Output: `dist`. `vercel.json` adds permanent redirects from
`/index.html` and `/guides/index.html` and sets CSP, HSTS, referrer, permissions and framing headers.

### GitHub Pages

The default `BASE=/File-Organizer-Web/` matches a project site. Push `dist/` to `gh-pages`, or use an
action that builds and deploys it. The generated `sitemap.xml` and `robots.txt` use the configured
canonical origin.

## Third-party licenses

- [pdf-lib](https://github.com/Hopding/pdf-lib) — MIT
- [@pdf-lib/fontkit](https://github.com/Hopding/fontkit) — MIT
- [Noto Sans](https://fonts.google.com/noto/specimen/Noto+Sans) — SIL Open Font License 1.1; the
  license text is bundled at `public/fonts/OFL.txt`
- Playwright, Vite, TypeScript and Vitest — their respective open-source licenses

The AuraFlow Web source code is MIT licensed, matching the desktop project.

## Contact

- Privacy or security: `thisissaddu3@gmail.com`
- Source: <https://github.com/heyitssuzain/File-Organizer-Web>
- Desktop app: <https://github.com/heyitssuzain/File-Organiser>
