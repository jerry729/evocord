# Security policy

evocord gives a language model, reachable by everyone in your Discord channels, access to tools on your machine.
The threat model and the controls are described in the README's [Security model](README.md#security-model) and in
the invariants in [DEVELOPING.md](DEVELOPING.md#security-invariants).

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's **"Report a vulnerability"** button
(Security tab → Advisories) rather than in a public issue. Include steps to reproduce and the impact you observed.

Especially interesting:
- ways for a non-admin Discord user to make the bot read host files, secrets or the Claude credentials;
- ways to execute code on the host (outside the Docker sandbox) without an admin approving a self-update;
- ways to bypass the admin checks on self-updates, `!bot` commands or buttons;
- sandbox escapes that work with the default `run_code` container flags.

Prompt-injection that only changes what the bot *says* is a known limitation, not a vulnerability, unless it crosses
one of the boundaries above.
