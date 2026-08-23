# pi-footer

A compact, two-line footer for [Pi](https://github.com/earendil-works/pi) with model and thinking status, working directory, Git state, session name, context usage, and provider quota information.

```text
● model: gpt-5.6-sol │ effort: high │ dir: ~/Project/app │ git: main* │ session: feature-work
▸ context ■■■□□□□□□□ 31% (325k/1.1M) │ weekly ■■■□□□□□□□ 34% (reset 4d2h)
```

## Features

- Two aligned, background-free status rows
- Model, thinking level, working directory, Git branch, and `/name` session display
- Git dirty state plus ahead/behind counts
- Context usage with token counts
- Provider quota lookup with reset countdowns
- Ten-cell segmented progress bars
- Theme-independent usage thresholds: green below 50%, yellow from 50% to below 75%, red at 75% and above
- Truecolor output with a 256-color fallback
- Automatic refresh on startup, model changes, session renames, Git changes, and every five minutes for quotas

## Install

### GitHub

```bash
pi install git:github.com/mhjerryjin/pi-footer
```

### npm

After the npm package is published:

```bash
pi install npm:@mhjerryjin/pi-footer
```

Run `/reload` after replacing another footer extension in an active Pi session.

## Usage

Set a session name with Pi's built-in command:

```text
/name feature-work
```

The footer updates immediately when the name changes.

## Configuration

All environment variables are optional:

| Variable                              | Description                                              | Default |
| ------------------------------------- | -------------------------------------------------------- | ------- |
| `PI_MINIMAL_FOOTER_SHOW_SESSION_NAME` | Show the explicit session name set with `/name`          | `1`     |
| `PI_MINIMAL_FOOTER_SHOW_CWD`          | Show the current working directory                       | `1`     |
| `PI_MINIMAL_FOOTER_SHOW_BRANCH`       | Show Git branch, dirty state, and ahead/behind counts    | `1`     |

Accepted false values are `0`, `false`, `no`, and `off` (case-insensitive).

## Provider support

The extension contains quota adapters for:

- Anthropic Claude Max
- OpenAI Codex
- GitHub Copilot
- Google Gemini CLI
- MiniMax and MiniMax CN
- Kimi Coding
- CommandCode
- OpenCode Go and OpenCode Zen
- OpenRouter

The customized compact layout displays a `weekly` block only when the active provider returns a weekly quota window. Model, effort, Git, session, and context information remain available for other Pi models and providers.

## Credentials and privacy

To query quota endpoints, the extension reads credentials already stored by Pi in `~/.pi/agent/auth.json`, standard provider environment variables, and documented provider-specific local credential files. Credentials are used only for the selected provider's quota request and are not printed or sent to an author-operated service.

See [SECURITY.md](SECURITY.md) for the complete credential and network behavior.

## Platform notes

The implementation uses cross-platform Node.js APIs and is designed for macOS, Linux, and Windows. Git information requires `git` on `PATH`. The symbols `●`, `▸`, `■`, and `│` require a modern Unicode-capable terminal; Windows Terminal is recommended on Windows.

## Credits

This project is based on [`@kvoon/pi-minimal-footer`](https://www.npmjs.com/package/@kvoon/pi-minimal-footer), which is itself based on `@ogulcancelik/pi-minimal-footer` by Can Celik. Their original copyright notices are retained in [LICENSE](LICENSE).

## License

MIT
