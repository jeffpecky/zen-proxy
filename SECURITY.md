# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for a security problem. Use GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
(Security → Report a vulnerability) on this repository. You will get a response
within a few days. If it turns out not to be exploitable, we will say so and
explain why.

## What this project handles

zen-proxy runs on your machine and proxies model traffic. That makes a few
things security-relevant, and they are worth stating plainly so you can judge
your own deployment:

- **It holds credentials.** `zen-proxy.json` may contain a Zen API key
  (`defaultZenKey`), a dashboard login password (`adminPassword`), and the client
  API key. The file is written `0600` through a temp file and a rename
  specifically so a secret is never readable at the final path. Do not commit
  it; it is in `.gitignore`.
- **A client API key is required on every model call.** There is no anonymous
  path: every install mints an `sk-…` key at first boot, callers present it, and
  authentication compares its SHA-256 in constant time. Removing the key from
  `apiKeys` (or regenerating it) revokes access immediately.
- **It binds to loopback by default** (`127.0.0.1`). If you set `host` to
  `0.0.0.0`, anyone who can reach the port and holds the client key can spend
  your quota and, with a BYOK key configured, your account's credentials. Set
  `adminPassword` too before exposing it — the dashboard and `/api/*` are open
  without one on any non-loopback bind only until boot mints one.
- **The dashboard password is separate from the client key.** The password opens
  the UI and `/api/*`; it never authenticates a model call. The client key
  authenticates model calls and never logs in. Losing one does not imply the
  other.
- **Admin writes are origin- and content-type-gated** so a web page you happen
  to visit cannot reconfigure the proxy through your browser. Requests without
  a JSON content type are refused with `415`.
- **Forwarded headers are ignored unless `trustForwarded=1`.** If you put this
  behind a reverse proxy, set it — otherwise every caller shares one rate-limit
  bucket and one identity.
- **Upstream traffic is TLS-impersonated** by `wreq-js` to look like the
  OpenCode CLI. That is the point of the project, but it means the TLS layer is a
  native addon pinned in `package-lock.json`. `npm ci` is used by the installers
  so two installs resolve the same build.

## Out of scope

- The upstream gateway refusing your requests. That is the service's decision,
  not a vulnerability here.
- Model output content.
- Anything that requires an attacker to already have local code execution with
  your user's privileges (they can read `zen-proxy.json` directly).

## Supported versions

The project is pre-1.1 and ships from `main`. Security fixes land on `main`; use
the latest commit or release.
