# Security and privacy

Pi extensions execute with the same local permissions as Pi. Review the source before installation.

## Credential access

`pi-footer` can read credentials from:

- `~/.pi/agent/auth.json`, populated by Pi `/login`
- Standard provider environment variables
- Provider-specific local credential files used as fallbacks
- The macOS Keychain for Claude credentials, on macOS only

The active provider's credential is used only for that provider's quota or billing endpoint. Shared multi-provider auth stores are read through provider-scoped fields; generic root credentials are accepted only from a provider's own credential file. The extension does not print credentials, persist copies, add telemetry, or send credentials to an author-operated service. Quota snapshots are cached only in process memory.

Pi-compatible credential values beginning with `!` are treated as local credential-helper commands and executed with a two-second timeout. Only use this form in trusted local configuration.

OpenCode Go and OpenCode Zen usage is calculated asynchronously from Pi's local session cost records instead of a remote quota endpoint. These values are estimates: they exclude usage from other clients and provider-side adjustments. OpenCode Go's built-in dollar limits are plan assumptions rather than authoritative provider quotas.

If a credential is unavailable or a quota request fails, the quota block is hidden and the remaining footer continues to work.

## Network behavior

Quota requests go directly to the selected provider's API endpoint. Provider APIs and authentication requirements can change independently of this project. Review the relevant fetcher in `index.ts` before enabling a provider in a sensitive environment.

## Reporting vulnerabilities

Please use GitHub Security Advisories for private vulnerability reports:

https://github.com/mhjerryjin/pi-footer/security/advisories/new
