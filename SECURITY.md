# Security policy

The review tool runs a small HTTP server on your machine. It binds to `127.0.0.1` by default, refuses
requests with a foreign `Host` or `Origin` header and validates everything it writes. See
[docs/architecture.md](docs/architecture.md#security-model) for details.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's
[private vulnerability reporting](https://github.com/matbmoser/ai-video-review-tool/security/advisories/new)
instead, with steps to reproduce and the version you tested (`video-review --version`).

You will get an answer as soon as possible; fixes are released as a new version and noted in the changelog.

## Supported versions

Only the latest release receives security fixes.
