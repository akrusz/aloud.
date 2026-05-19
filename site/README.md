# aloud. landing page

Static site for the public aloud. landing page. Hand-written; no build step.

## structure

```
site/
  index.html      ← page content + structure
  css/style.css   ← brand tokens lifted from docs/style.md
  js/download.js  ← fetches latest GitHub release at page load
  assets/
    aloud.png         ← icon (favicon + og:image)
    aloud-screen.png  ← screenshot
```

## local preview

Any static server. From the repo root:

```bash
python3 -m http.server -d site 8000
# then open http://localhost:8000
```

## download wiring

`js/download.js` calls `https://api.github.com/repos/akrusz/aloud/releases/latest`
on page load and rewrites the three download-card `href`s with the latest
release asset URLs. If the API fails (rate-limited, offline, etc.) it falls
back to `https://github.com/akrusz/aloud/releases/latest` for all three.

This means the site never needs to be re-deployed when a new version ships
— `scripts/release.sh` triggers the build workflow, the workflow uploads
assets, the next page load picks them up.

## deployment

Two reasonable paths:

### Porkbun static hosting (pulls from this repo)

Point Porkbun's static site setting at the `site/` subfolder of this repo
and the default branch. It will serve directly from there. No build step.

### GitHub Pages (free)

In repo settings → Pages, set source to "Deploy from a branch", branch
`main`, folder `/site`. Custom domain via CNAME if desired.

## brand assets

The `site/assets/` files are copied from `assets/aloud.png` and
`docs/aloud-screen.png`. Keep them in sync if either source updates —
or replace with a small symlink-equivalent in a future deploy script.

## things to fill in

- [ ] real "buy me a coffee" / Ko-fi URL in `index.html`
      (currently `href="#"` placeholder for the second tip button)
- [ ] confirm GitHub Sponsors page exists at `github.com/sponsors/akrusz`
      or replace with the real sponsorship link
- [ ] consider a slightly nicer og:image (the icon works but a custom
      1200×630 social card would render better in link previews)
