# pi-footer

A compact footer for [Pi](https://github.com/earendil-works/pi) with two core status rows plus a stable work-status row for active tools and subagents. It shows model and thinking status, working directory, Git state, session name, context usage, provider quotas, and active work.

## Preview

![pi-footer showing model, effort, working directory, Git branch, context usage, weekly quota, and active agents](https://raw.githubusercontent.com/mhjerryjin/pi-footer/main/assets/pi-footer-preview.png)

## Features

- Two aligned, background-free core rows plus a stable work-status row
- Model, thinking level, working directory, Git branch, and `/name` session display
- Git dirty state plus ahead/behind counts
- Context usage with token counts
- Provider quota lookup with reset countdowns
- Ten-cell segmented progress bars
- Theme-independent usage thresholds: green below 50%, yellow from 50% to below 75%, red at 75% and above
- Truecolor output with a 256-color fallback
- Automatic refresh on startup, model changes, session renames, Git changes, and every five minutes for quotas
- Active parent tool and `pi-subagents` agent/background counts without layout shifts
- Distinct `●` model, threshold-colored `◐` context, and `↳` work-status icons

## Install

### GitHub

```bash
pi install git:github.com/mhjerryjin/pi-footer
```

### npm

```bash
pi install npm:@mhjerryjin/pi-footer
```

Run `/reload` after replacing another footer extension in an active Pi session.

## Usage

Set a session name with Pi's built-in command:

```text
/name feature-work
```

The footer and terminal tab title update immediately when the name changes:

```text
pi · feature-work
```

Without an explicit session name, the title falls back to the current project, for example `pi · pi-footer`.

Most terminal emulators honor the title sequence automatically. VS Code defaults to the foreground process name (`node`); set this in VS Code User Settings to display the title sent by Pi:

```json
{
  "terminal.integrated.tabs.title": "${sequence}"
}
```

## Work status

While work is active, a compact third row appears automatically:

```text
● model: gpt-5.6-sol │ effort: high │ git: main
◐ context ■■■□□□□□□□ 31% │ weekly ■■■□□□□□□□ 34%
↳ task: bash · 12s │ agents: 1/2 · reviewer running │ bg: 1/4
```

- `task`/`tasks` tracks tools currently running in the parent Pi session.
- `agents` shows active/total child progress plus active agent labels from the versioned `pi-subagents` async snapshot, falling back to Fleet counts for older releases.
- `bg` is active top-level asynchronous subagent work and its configured capacity.
- The row stays reserved but blank while idle, preventing the editor and footer from jumping when work starts or stops.

The `pi-subagents` integration is optional and uses its versioned in-process event-bus API, so `pi-footer` has no hard dependency on that package. FleetView remains responsible for per-agent details and controls such as inspect, stop, and steer.

## Configuration

All environment variables are optional:

| Variable                              | Description                                              | Default |
| ------------------------------------- | -------------------------------------------------------- | ------- |
| `PI_MINIMAL_FOOTER_SHOW_SESSION_NAME` | Show the explicit session name set with `/name`          | `1`     |
| `PI_MINIMAL_FOOTER_SHOW_CWD`          | Show the current working directory                       | `1`     |
| `PI_MINIMAL_FOOTER_SHOW_BRANCH`       | Show Git branch, dirty state, and ahead/behind counts    | `1`     |
| `PI_MINIMAL_FOOTER_SHOW_WORK_STATUS`  | Reserve and show the work summary row                     | `1`     |
| `PI_MINIMAL_FOOTER_SET_TERMINAL_TITLE` | Update terminal title from the session/project name       | `1`     |

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

The compact layout prefers a `weekly` window. When a provider has no weekly window, it displays the provider's most-used available quota or balance window instead.

## Credentials and privacy

To query quota endpoints, the extension reads provider-scoped credentials already stored by Pi in `~/.pi/agent/auth.json`, standard provider environment variables, and documented provider-specific local credential files. Credentials are used only for the selected provider's request and are not printed or sent to an author-operated service. OpenCode Go/Zen values are local estimates based only on Pi session records.

See [SECURITY.md](SECURITY.md) for the complete credential and network behavior.

## Platform notes

The implementation uses cross-platform Node.js APIs and is designed for macOS, Linux, and Windows. Git information requires `git` on `PATH`. The symbols `●`, `◐`, `↳`, `■`, and `│` require a modern Unicode-capable terminal; Windows Terminal is recommended on Windows.

## Credits

This project is based on [`@kvoon/pi-minimal-footer`](https://www.npmjs.com/package/@kvoon/pi-minimal-footer), which is itself based on `@ogulcancelik/pi-minimal-footer` by Can Celik. Their original copyright notices are retained in [LICENSE](LICENSE).

## License

MIT
