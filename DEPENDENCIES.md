# Dependencies

The review tool itself is MIT licensed (see [LICENSE](LICENSE)). This file lists the third-party software it
uses or ships, and the services it can talk to.

## Python

**None at runtime.** The `video-review` command uses the Python standard library only (Python 3.10+).

For development (`pip install -e ".[dev]"`):

| Package | Used for | License |
| --- | --- | --- |
| [pytest](https://pytest.org) ≥ 7 | the test suite | MIT |
| [Ruff](https://docs.astral.sh/ruff/) ≥ 0.5 | linting and import sorting | MIT |

## Browser libraries (vendored)

Shipped unmodified in [`src/video_review/static/vendor/`](src/video_review/static/vendor/) together with
their license files, so the page works offline and needs no build step. Only the `sourceMappingURL`
comment was removed. They are loaded only when the ✦ Claude panel is opened.

| Library | Version | Files | Used for | License | Source |
| --- | --- | --- | --- | --- | --- |
| [xterm.js](https://xtermjs.org) | 6.0.0 | `vendor/xterm/xterm.js`, `vendor/xterm/xterm.css` | the Claude Code terminal | MIT, [`vendor/xterm/LICENSE`](src/video_review/static/vendor/xterm/LICENSE) | npm [`@xterm/xterm`](https://www.npmjs.com/package/@xterm/xterm), [GitHub](https://github.com/xtermjs/xterm.js) |
| [@xterm/addon-fit](https://github.com/xtermjs/xterm.js/tree/master/addons/addon-fit) | 0.11.0 | `vendor/xterm/addon-fit.js` | sizing the terminal to the panel | MIT, [`vendor/xterm/LICENSE-addon-fit`](src/video_review/static/vendor/xterm/LICENSE-addon-fit) | npm [`@xterm/addon-fit`](https://www.npmjs.com/package/@xterm/addon-fit) |
| [Deep Chat](https://deepchat.dev) | 2.5.1 | `vendor/deep-chat/deepChat.bundle.js` | the chat with Claude (API key) | MIT, [`vendor/deep-chat/LICENSE`](src/video_review/static/vendor/deep-chat/LICENSE) | npm [`deep-chat`](https://www.npmjs.com/package/deep-chat), [GitHub](https://github.com/OvidijusParsiunas/deep-chat) |
| [highlight.js](https://highlightjs.org) | 11.11.1 | `vendor/highlight/highlight.min.js`, `vendor/highlight/github-dark.min.css` | coloured code in chat answers | BSD-3-Clause, [`vendor/highlight/LICENSE`](src/video_review/static/vendor/highlight/LICENSE) | npm [`@highlightjs/cdn-assets`](https://www.npmjs.com/package/@highlightjs/cdn-assets), [GitHub](https://github.com/highlightjs/highlight.js) |

The Deep Chat bundle contains its own dependencies:
[remarkable](https://github.com/jonschlinkert/remarkable) (Markdown, MIT),
[@microsoft/fetch-event-source](https://github.com/Azure/fetch-event-source) (streaming, MIT) and
[speech-to-element](https://github.com/OvidijusParsiunas/speech-to-element) (MIT, not used by the tool).

The browser version on GitHub Pages ships the same files except xterm.js (it has no terminal).

To update a library: download the package (`npm pack <name>@<version>`), copy the files listed above,
then update this table, [`static/vendor/README.md`](src/video_review/static/vendor/README.md) and the
[changelog](CHANGELOG.md).

## Programs and services (not shipped)

| What | Used for | Notes |
| --- | --- | --- |
| [Claude Code](https://claude.com/claude-code) (`claude`) | the Claude Code tab of the ✦ Claude panel | optional; installed and signed in by you, started in your project folder (`--claude-command` to change it) |
| [Anthropic Messages API](https://docs.claude.com) (`api.anthropic.com`) | the chat tab | optional; only with your own API key, billed to your Anthropic account; no other network requests are made |
| a web browser | the review page | plays the video itself (H.264 MP4 in Chrome, Edge and Safari; VP9/AV1 WebM in Chrome and Firefox) |

## GitHub Actions (CI and GitHub Pages)

| Action | Used in | License |
| --- | --- | --- |
| [actions/checkout](https://github.com/actions/checkout) v5 | CI, Pages | MIT |
| [actions/setup-python](https://github.com/actions/setup-python) v6 | CI, Pages | MIT |
| [actions/configure-pages](https://github.com/actions/configure-pages) v5 | Pages | MIT |
| [actions/upload-pages-artifact](https://github.com/actions/upload-pages-artifact) v4 | Pages | MIT |
| [actions/deploy-pages](https://github.com/actions/deploy-pages) v4 | Pages | MIT |
