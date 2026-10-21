# Deploying AuraFlow Web to Vercel

Deployment is approved from a security standpoint (see `SECURITY_FIX_REPORT.md`).
Follow these steps exactly — the two environment variables below are **required**,
otherwise the build falls back to GitHub Pages paths and every page 404s.

## Option A — Deploy with the Vercel CLI (recommended; no GitHub push needed)

```powershell
# from C:\Users\ADMIN\Desktop\Aura\File-Organizer-Web
npx vercel login
npx vercel          # links the folder, creates <name>.vercel.app preview
# then set the project settings (dashboard or CLI):
#   Settings → Environment Variables → add the two vars below
#   Settings → Build & Output → Framework Preset: Vite
npx vercel --prod   # production deploy
```

## Option B — Import from GitHub

1. Push this project to a GitHub repository (it can live in its own repo, or the
   parent `Aura` repo with **Root Directory: `File-Organizer-Web`** in Vercel's
   project settings).
2. Import it in Vercel → Framework Preset **Vite**.
3. Add the environment variables below → deploy.

## Required environment variables (Project Settings → Environment Variables)

| Variable | Value for first deploy | Value once the domain is final |
|---|---|---|
| `BASE` | `/` | `/` |
| `CANONICAL_BASE_URL` | `https://<project>.vercel.app/` (best guess) | **the final URL with trailing slash**, e.g. `https://auraflow-web.vercel.app/` or your custom domain |

- `BASE=/` because Vercel serves the site at the domain root (GitHub Pages'
  `/File-Organizer-Web/` prefix must NOT be used there).
- `CANONICAL_BASE_URL` drives every `<link rel="canonical">`, OG URL, sitemap.xml
  and robots.txt entry. **If you later add a custom domain, update this var and
  redeploy** so SEO metadata matches where users actually visit.
- `vercel.json` (already in this folder) adds the CSP and security headers —
  nothing else to configure for them.

## Post-deploy verification (copy-paste)

```powershell
# 1. homepage 200
curl.exe -sI https://<your-domain>/ | findstr /i "HTTP"
# 2. CSP + security headers are live
curl.exe -sI https://<your-domain>/ | findstr /i "content-security-policy x-content-type-options referrer-policy"
# 3. unknown route serves the 404 page (status 404, body contains "unorganized")
curl.exe -s -o NUL -w "%{http_code}" https://<your-domain>/no-such-page.html
# 4. sitemap uses the final domain
curl.exe -s https://<your-domain>/sitemap.xml | findstr /i "loc" | Select-Object -First 4
# 5. toolkit pages exist
curl.exe -s -o NUL -w "%{http_code} converter`n" https://<your-domain>/converter.html
curl.exe -s -o NUL -w "%{http_code} image-to-pdf`n" https://<your-domain>/image-to-pdf.html
curl.exe -s -o NUL -w "%{http_code} pdf-merger`n" https://<your-domain>/pdf-merger.html
```

Then in a real browser: run one organizer flow end-to-end (pick files → plan →
download manifest), convert one image and one text file, merge two PDFs, and make
a two-image PDF. Confirm the Web Worker appears in DevTools → Sources, the Network
tab shows no external request carrying file data, and no console errors appear.
Check the homepage and all three toolkit pages on a phone (375 px) without
horizontal scroll.

## Known, documented limitations (non-blocking)

- `vite preview` locally serves `index.html` for unknown routes with HTTP 200 —
  on Vercel the custom `404.html` is served (verify with check #3 above).
- If a custom domain is added later, redeploy AFTER updating `CANONICAL_BASE_URL`.
- The first local `playwright` use requires `npx playwright install chromium`
  (only relevant to the dev smoke test, not to deployment).
