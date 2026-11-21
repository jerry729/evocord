# Contributing

Thanks for helping! A few guidelines:

- Read [DEVELOPING.md](DEVELOPING.md) first — especially the **security invariants**. Changes that loosen them need a
  clear reason in the PR description.
- Keep the core small. Many features are better added to your own instance through self-evolution than upstream;
  upstream is for things most deployments need.
- Before opening a PR run:
  ```bash
  bun run check && bun test && python3 -m unittest discover -s tests
  ```
  Tests must not need Discord, a token, a GPU or network access.
- Never commit `config/bot.json`, anything under `state/`, `memory/` contents, tokens, logs or transcripts.
  `.gitignore` covers them — don't force-add.
- Use a GitHub no-reply email for your commits if you don't want your address in the public history.
