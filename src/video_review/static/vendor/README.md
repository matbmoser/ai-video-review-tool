# Third-party files

These libraries are shipped unmodified (only the `sourceMappingURL` comment was removed), so the tool
works offline and without a build step. They are only loaded when the ✦ Claude panel is opened. highlight.js colours code in the chat's answers.

| Library | Version | Files | License | Source |
| --- | --- | --- | --- | --- |
| [xterm.js](https://xtermjs.org) | 6.0.0 | `xterm/xterm.js`, `xterm/xterm.css` | MIT, `xterm/LICENSE` | npm `@xterm/xterm` |
| [@xterm/addon-fit](https://github.com/xtermjs/xterm.js/tree/master/addons/addon-fit) | 0.11.0 | `xterm/addon-fit.js` | MIT, `xterm/LICENSE-addon-fit` | npm `@xterm/addon-fit` |
| [highlight.js](https://highlightjs.org) | 11.11.1 | `highlight/highlight.min.js`, `highlight/github-dark.min.css` | BSD-3-Clause, `highlight/LICENSE` | npm `@highlightjs/cdn-assets` |
| [Deep Chat](https://deepchat.dev) | 2.5.1 | `deep-chat/deepChat.bundle.js` | MIT, `deep-chat/LICENSE` | npm `deep-chat` (`dist/deepChat.bundle.js`) |

To update one, download the package (`npm pack <name>@<version>`), copy the files listed above and
update this table and `CHANGELOG.md`.
