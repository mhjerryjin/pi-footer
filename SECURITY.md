# Security and privacy

Pi extensions execute with the same local permissions as Pi. Review the source before installation.

## Credential access

`pi-footer` can read credentials from:

- `~/.pi/agent/auth.json`, populated by Pi `/login`
- Standard provider environment variables
- Provider-specific local credential files used as fallbacks
- The macOS Keychain for Claude credentials, on macOS only

The active provider's credential is used to call that provider's quota or billing endpoint. The extension does not print credentials, persist copies, add telemetry, or send credentials to an author-operated service. Quota snapshots are cached only in process memory.

OpenCode Go and OpenCode Zen usage is calculated from Pi's local session cost records instead of a remote quota endpoint.

If a credential is unavailable or a quota request fails, the quota block is hidden and the remaining footer continues to work.

## Network behavior

Quota requests go directly to the selected provider's API endpoint. Provider APIs and authentication requirements can change independently of this project. Review the relevant fetcher in `index.ts` before enabling a provider in a sensitive environment.

## Reporting vulnerabilities

Please use GitHub Security Advisories for private vulnerability reports:

https://github.com/mhjerryjin/pi-footer/security/advisories/new
