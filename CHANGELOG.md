# Changelog

## 0.1.5

- Show subagent progress as active/total with grouped active-agent labels.
- Prefer the versioned async status snapshot so completed workflow steps no longer inflate the active count.

## 0.1.4

- Fix terminal titles being overwritten by Pi's built-in title update after session startup, reload, or rename.

## 0.1.3

- Keep terminal tab titles synchronized as `pi · <session>`, with the project name as fallback.
- Document the VS Code `${sequence}` tab-title setting.

## 0.1.2

- Add a stable reserved work-status row for active parent tools without layout shifts.
- Integrate optionally with `pi-subagents` Fleet Status RPC for active agent and background-run counts.
- Replace the context disclosure triangle with a usage-oriented `◐` icon that follows context threshold colors.
- Restrict CommandCode shared-auth lookup to provider-scoped credentials.
- Clear stale quota data immediately on provider switches and display a non-weekly fallback window when needed.
- Make OpenCode session-cost scanning asynchronous and enforce the documented Zen 30-day window.
- Add terminal-text sanitization, boundary-aware home abbreviation, automated tests, type checking, and CI.

## 0.1.1

- Add the footer screenshot to the Pi Package Gallery metadata.
- Update npm installation and package listing documentation.

## 0.1.0

- Publish the initial `@mhjerryjin/pi-footer` package.
- Add a compact two-line footer with aligned status icons and segmented gauges.
- Display Pi session names and refresh immediately after `/name` changes.
- Add provider quota adapters, context usage, and Git status.
- Use theme-independent green, yellow, and red progress thresholds.
- Document credential access, network behavior, upstream attribution, and platform notes.
