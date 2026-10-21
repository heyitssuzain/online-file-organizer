# AuraFlow Web — Security & Bugfix Report

**Date:** 2026-10-20  
**Repo:** `heyitssuzain/File-Organizer-Web` (local working copy)  
**Status:** Fixed, pushed to GitHub, deployed to Vercel production, and verified against the live site.

---

## 1. What was broken

| Area | Previous behaviour | Risk |
|---|---|---|
| Folder selection | The folder handle was thrown away after scanning; only file contents were kept. | The app could never actually move a file selected with the folder picker. |
| Execute | `executePlan` always copied. There was no move implementation. | “Organize” silently behaved as Copy, so originals were never moved. |
| Move implementation | It called `directoryHandle.move(...)`, which is non-standard for user-picked local folders. | Move either failed or was unavailable. |
| Rescanning | A second scan included the app’s own `Documents/`, `Images/`, `YYYY-MM/` folders. | Output was reprocessed, producing nested/duplicate category folders. |
| Capability detection | Detection was too shallow and could offer real-folder actions in browsers that could not perform them. | Users could be told a move happened when only a copy or ZIP was produced. |
| Same-folder workflow | There was no way to say “sort inside this folder”; users had to pick a destination again. | Confusing UX and unnecessary permission prompts. |
| Move/Copy choice | No explicit choice; results were not labelled honestly. | Users could not tell whether originals were removed. |

---

## 2. What changed

### `src/fs/access.ts`
- Added capability detection for:
  - directory picker (`showDirectoryPicker`)
  - writable file handles (`createWritable`)
  - removable directory entries (`removeEntry`)
- Added `verifyPermission()` for read/write permission checks.
- Recursive folder scanning now records, for every file:
  - its relative path
  - its `FileSystemFileHandle`
  - its parent directory handle
- Root-level app output folders are skipped during scans:
  - category folders (`Documents`, `Images`, …)
  - `YYYY-MM` date folders
  - **only at the selected root**; nested folders with the same names remain scannable
- The `<input webkitdirectory>` fallback applies the same root-level skip policy.
- Added destination snapshots so conflicts can be resolved in the preview.
- Added `MAX_FILES` warning/cap handling for input selections.

### `src/fs/operations.ts`
- Replaced the unreliable native `move()` dependency with a verified **copy → verify → remove** move:
  1. write a full destination copy
  2. close the writable
  3. read the destination back and verify its size
  4. re-check that the source still exists and has not changed
  5. verify the source directory entry is still the same file
  6. remove the source
  7. confirm the source name is gone
- If any step fails, the original is preserved.
- If removal is impossible, the record is reported as **copied**, never moved.
- If the source changed after the scan, the original is kept and the record is reported as copied.
- If the source name now belongs to a different file, that file is not removed.
- Destinations are never opened for writing until `availableName()` has found a free name.
- Existing destination names are re-checked at execution time, not only in the preview.
- Failed/partial destination writes are cleaned up best-effort.
- Copy mode leaves originals untouched.
- Undo:
  - restores true moves only
  - works across different source/destination folders
  - restores nested paths
  - refuses to remove a destination entry that changed before undo removal
  - removes now-empty top-level destination folders
- Added the run rule to the manifest (`type`, `date`, `extension`) instead of the old `user-confirmed` placeholder.

### `src/pages/organizer.ts`
- Keeps source handles/parents in the selection state.
- Added **Sort inside this folder** for picker/drop selections.
- Added **Choose a different folder** for cross-folder move or copy.
- Move is the default for folder selections; **Copy instead of move — keep the originals** is explicit.
- Moves always ask for confirmation.
- Copy mode is forced when the browser/source cannot remove originals (e.g. file-input selections).
- Preview re-plans with existing destination filenames asynchronously.
- Results now distinguish:
  - moved
  - copied (originals kept)
  - exported (originals kept)
- Fixed the plan preview that previously displayed only `/` instead of the destination folder.
- Undo results now show an explicit “Run was undone” note and do not fabricate an error count.
- If some files could only be copied, undoing the moved files explains that copied files remain.
- Skip warnings for already-organized folders are informational, not red errors.
- Export/manifest labels match the actual workflow.

### `src/core/categories.ts`
- Added `CATEGORY_NAMES` and `isCategoryFolderName()` used by the scan skip policy.

### `src/core/manifest.ts`
- Added `statusOf()` and accurate moved/copied/exported reporting.
- Report summary remains backward-compatible for move-only reports:
  `2 moved · 1 skipped · 1 errors`
  and adds copied/exported only when present.

### `organizer.html`
- Added same-folder/other-folder actions and the copy/move switch.
- Added explicit copy/move/overwrite safety copy.
- ZIP fallback wording states that originals are untouched.

### Temporary verification harnesses (not committed)
- `tests/fs-operations.test.ts` — 19 in-memory filesystem tests.
- `scripts/test-organizer-flow.mjs` — browser flow tests with an injected in-memory directory handle.

These harnesses were run successfully, then removed from both working copies before publishing so the deployment does not include test-only files. They are backed up outside the repositories for future use.

---

## 3. Safety invariants now enforced

1. **No overwrite:** destination names are resolved against both the preview snapshot and the live folder at write time; conflicts become `_1`, `_2`, …
2. **Verified move:** the original is removed only after the destination is written, closed, read back, and size-verified.
3. **Failure preserves originals:** write, verification, permission, or removal failures leave the original untouched.
4. **Honest labels:** a copy or ZIP is never reported as a move.
5. **No silent source deletion:** if the source cannot be re-checked, changed after the scan, or its name now points to another file, it is not removed.
6. **No reprocessing output:** root-level category/date folders are skipped on later scans.
7. **No uploads/backend:** all reads, writes, hashing, and ZIP creation stay in the browser.
8. **Undo scope:** only true moves are undoable; copied files intentionally remain.

---

## 4. Verification actually run

### Typecheck
```text
npx tsc --noEmit
→ clean (no output)
```

### Unit/integration tests
```text
# with the temporary verification harnesses:
npm test -- --run
→ Test Files  7 passed (7)
→ Tests       83 passed (83)

# after removing the temporary harnesses, the shipped test suite:
npm test -- --run
→ Test Files  6 passed (6)
→ Tests       64 passed (64)
```

Covered during verification:
- nested folder discovery
- root-only destination-folder skipping
- `<input webkitdirectory>` fallback skipping
- same-folder move
- second scan does not reprocess output
- nested source paths and undo
- copy vs move
- cross-folder move and cross-folder undo
- removal failure → reported as copied
- runtime conflict rename without preview snapshot
- preview snapshot conflict rename
- write failure preserves original
- truncated write / verification failure preserves original
- permission denial
- source changed after scan preserves current original
- replaced source name is not removed
- feature detection with and without required APIs

### Production build
```text
npm run build
→ tsc --noEmit + vite build succeeded
→ 35 modules transformed
→ sitemap.xml and robots.txt generated
```

### Browser flow test (temporary harness, removed after testing)
```text
node scripts/test-organizer-flow.mjs
→ PASS  folder discovery + same-folder move + undo
→ PASS  copy mode keeps originals
→ PASS  unsupported browser gets honest ZIP fallback
→ All browser organizer checks passed.
```

The browser test replaced only `window.showDirectoryPicker` with an in-page in-memory handle. The application code ran unmodified. This covered the real API contract (handles, `getFile`, `createWritable`, `removeEntry`, `isSameEntry`) without touching a real user folder.

### Existing smoke suite
```text
node scripts/smoke.mjs
→ 37/37 passed
```
Includes 12 pages with no console errors, no failed network requests, responsive checks, plan previews, duplicate scan, date/extension rules, downloads, and organizer panel behaviour.

### Environment limitation
The bundled Playwright Chromium headless shell was incomplete on this machine (`chromium_headless_shell-1193` missing). Tests used the installed **Microsoft Edge (Chromium)** channel instead. This is the same Blink engine family and exposes the same File System Access API surface.

---

## 5. Known limitations / residual risks

- **Native folder picker is not automated.** Operating-system dialogs cannot be driven by Playwright. Real folder permission prompts and real disk writes must still be manually verified.
- **Size verification only.** The destination is read back and its byte size is verified. This catches truncation and failed writes. It is not a full content hash of every file (hashing every file would double I/O and make large folders much slower). Existing duplicates use SHA-256 separately.
- **File System Access API has no atomic “create exclusive new file” primitive.** Conflict detection is best-effort: names are checked before opening, and existing files are never intentionally opened for writing. A different application creating the same name in the tiny window between check and create remains a theoretical race.
- **Recursion depth remains 3**, matching the existing policy.
- **Undo is session-only.** It cannot survive a page reload; this is stated in the confirmation.
- **Root-level legitimate folders named like categories are skipped.** This is the deliberate trade-off for not reprocessing app output. Nested folders with those names are still scanned.
- **ZIP fallback is an export, not a move.** It is labelled exported/copied and states originals are untouched.
- **Browser-specific testing is still needed** in Firefox/Safari for the ZIP fallback and in Chrome/Edge for real folder permissions.

---

## 6. Deployment status

- Changes were developed and tested in:
  `C:\Users\ADMIN\Desktop\Aura\File-Organizer-Web`
- Production source repository:
  `heyitssuzain/online-file-organizer`
- Commit pushed to `main`:
  `c3b47dd — Fix folder discovery, verified moves, and ZIP fallback honesty`
- Vercel auto-deployed the commit to Production.
- Live URL:
  `https://online-file-organizer.vercel.app/`
- Live verification:
  - production page returns HTTP 200 and serves the new organizer controls
  - new organizer JavaScript includes the verified-move/source-change guards
  - live browser flow: folder discovery + same-folder move + undo, copy mode, and unsupported-browser ZIP fallback all passed
  - live smoke suite: **38/38 passed**, including custom 404 handling, canonical/OG metadata, sitemap, and no console/network errors
- No unrelated files were modified; the Google verification file and SEO output were left untouched.
- Temporary verification harnesses were removed before publishing; generated `dist/`, screenshot artifacts, and local clone scratch files were cleaned up.

### Manual verification checklist after deployment

1. Open the organizer in Chrome or Edge.
2. Choose a folder through the native picker; confirm the plan shows nested files.
3. Click **Sort inside this folder**, accept the move confirmation, and verify:
   - category folders are created inside the selected folder
   - files are present in the category folders
   - originals are gone
   - results say **moved**
4. Click **Undo this run** and verify the files return to their original paths.
5. Run the same folder again and confirm the app does **not** rescan its own category/date folders.
6. Choose a folder, select **Copy files**, choose a destination, and verify originals stay and results say **copied (originals kept)**.
7. Try an existing destination filename and verify a `_1` name is produced without overwriting.
8. Test in Firefox/Safari: verify the badge offers the ZIP, results say **exported (originals kept)**, and the toast says originals are untouched.

---

## 7. Move/Copy and Downloads-folder fix (October 2026)

### Reported problem
- The Move option could not be used when a folder was selected through the classic picker, so users only got Copy.
- Choosing Downloads in Chrome/Edge failed with "Cannot open this folder because it contains system files".

### What changed
- Replaced the single "copy instead of move" checkbox with explicit **Move files** / **Copy files** segmented buttons. Move is disabled only when the selection has no removable handle, and the reason is shown in the UI.
- Added a dedicated browser-block notice for Downloads/Documents with three paths: select files instead, try a subfolder, or continue copy-only.
- `Select files` now uses `showOpenFilePicker()` on Chromium, preserving a handle per file. Current Chromium can remove that original through `FileSystemFileHandle.remove()` after the verified copy, so individually picked Downloads files can be truly moved.
- `showOpenFilePicker({ startIn: 'downloads' })` is used from the blocked-folder notice, so Ctrl+A can select every file in Downloads.
- Moves through a parent directory handle still record undo. Moves through an individual file handle cannot be undone because the browser never exposes the parent folder; the result screen and manifest say so.
- Added graceful handling for blocked drag-and-drop folders and OS-owned root folders such as `$RECYCLE.BIN` and `System Volume Information`.
- Updated the Downloads cleanup guide, browser-limits guide and compatibility table with the real browser rule.

### Verification
- `npm run typecheck` - passed
- `npm test` - 67/67 passed
- `npm run build` - passed
- `node scripts/smoke.mjs` - 38/38 passed
- Browser probe: blocked folder notice appears; file-picker Move removes the originals and writes category folders; Copy keeps the originals; parent-folder Move keeps Undo; no console errors.

### Honest limitation
A web page still cannot open the Downloads/Documents root as a whole folder in Chromium. The working paths are the file picker (individually selected files) or a subfolder/drag-and-drop. This is a browser security rule, not an app bug; the desktop app can do whole-folder moves because it is native.

