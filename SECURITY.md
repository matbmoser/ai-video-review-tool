# Security policy

The review tool runs a small HTTP server on your machine. It binds to `127.0.0.1` by default, refuses
requests with a foreign `Host` or `Origin` header and validates everything it writes. See
[docs/architecture.md](docs/architecture.md#security-model) for details.

The **✦ Claude panel** can run Claude Code (a program that can change files) and use your Anthropic API
key, so it is only offered on `localhost` and every request needs a random token created at start-up.
Your API key is kept in memory only. Never commit API keys: use `ANTHROPIC_API_KEY` or paste the key into
the panel. Turn the parts off with `--no-terminal` and `--no-chat`.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's
[private vulnerability reporting](https://github.com/matbmoser/ai-video-review-tool/security/advisories/new)
instead, with steps to reproduce and the version you tested (`video-review --version`).

You will get an answer as soon as possible; fixes are released as a new version and noted in the changelog.

## Supported versions

Only the latest release receives security fixes.
