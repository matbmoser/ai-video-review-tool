# Static files of the review page

`index.html`, `app.css`, `app.js` (the review), `claude.js` (the ✦ Claude panel) and
`browser-backend.js` (storage for the GitHub Pages version) need no build step. Third-party libraries
are in [`vendor/`](vendor/README.md).

## GitHub mark on the GitHub button

The button in the top bar shows a generic code icon. To show GitHub's own mark instead, download the
**GitHub mark** SVG from <https://github.com/logos> (GitHub's logo guidelines allow it for linking to
GitHub) and save it here as `github-mark.svg`. The page picks it up automatically, in the installed tool
and in the GitHub Pages version, and draws it in the button's text colour.
