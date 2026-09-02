# Security policy

## Reporting a vulnerability

Please report a security vulnerability privately, using GitHub's private
vulnerability reporting: open this repository's **Security** tab and choose
**Report a vulnerability**. That starts a draft security advisory that only
you and the maintainers can see. Please don't open a public issue for
anything you believe is exploitable.

We aim to acknowledge a new report within five business days, and to follow
up with an assessment — a fix, a mitigation, or an explanation of why we
don't think it's exploitable — within two weeks after that. This project is
maintained by a small team, so those are targets rather than guarantees, but
you'll hear something back within that window either way.

## Credentials

flotilla never asks you to put a token in a settings file. Every credential
the engine needs — for your issue tracker or your code host — is resolved
through a lookup command you configure once; the engine runs that command at
the moment it actually needs the secret, uses the output, and holds nothing
at rest afterward. A short-lived environment such as CI can fall back to an
ordinary environment variable instead, but the configuration files
themselves — the ones that get committed to your repository — never carry a
secret value either way.

## Supported versions

Only the latest minor release gets security fixes. The engine
(`@formtrieb/flotilla-engine` on npm) and the Claude Code plugin are released
together and share one version number, so "supported" means the same thing
for both — see [CHANGELOG.md](CHANGELOG.md) for the current version and what
it contains.

| Version | Supported |
| --- | --- |
| latest minor | :white_check_mark: |
| anything older | :x: |

If you're running an older version, please upgrade before reporting — a fix
won't be backported to a version that's no longer current.

## Scope

This policy covers flotilla's own code: the engine and the Claude Code
plugin. It does not cover:

- how you've configured your own issue tracker or code host, or the
  permissions granted to the credential flotilla uses there — that's your
  access, on your infrastructure, and yours to secure;
- a vulnerability in GitHub, Linear, npm, or any other third-party service
  flotilla talks to — please report those directly to that vendor;
- behavior that requires an attacker to already hold the credentials or
  repository access flotilla itself was configured with — that's a report
  about your own environment, not about flotilla.

If you're not sure whether something is in scope, report it anyway — we'd
rather triage a false positive than miss a real one.
