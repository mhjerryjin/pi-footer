/**
 * Context Gauge Extension
 *
 * Custom footer with context gauge + subscription usage bars.
 * Auto-detects provider from current model and shows relevant usage.
 *
 * Supports: Claude Max, Codex, Copilot, Gemini, MiniMax Token Plan, Kimi Coding, CommandCode, OpenCode Go, OpenCode Zen, OpenRouter
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  buildSessionContext,
  estimateTokens,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import { execSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  readFile as readFileAsync,
  readdir as readdirAsync,
  stat as statAsync,
} from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";

// ============ Types ============

interface RateWindow {
  label: string;
  usedPercent: number;
  resetsIn?: string; // human readable "2h38m"
}

interface UsageSnapshot {
  provider: string;
  windows: RateWindow[];
  error?: string;
  fetchedAt: number;
}

interface GitCache {
  branch: string | null;
  dirty: boolean;
  ahead: number;
  behind: number;
}

interface AuthJson {
  [provider: string]: unknown;
  anthropic?: { access?: string };
  "github-copilot"?: { refresh?: string };
  "openai-codex"?: { access?: string; accountId?: string };
  "google-gemini-cli"?: { access?: string };
}

interface ActiveToolStatus {
  toolCallId: string;
  toolName: string;
  startedAt: number;
}

interface SubagentFleetSummary {
  activeAgents: number;
  totalAgents: number;
  agentLabels: string[];
  backgroundUsed: number;
  backgroundLimit: number;
}

interface AsyncAgentProgress {
  active: number;
  total: number;
  labels: string[];
}

interface SubagentRpcReply {
  version?: unknown;
  requestId?: unknown;
  success?: unknown;
  data?: unknown;
}

// ============ Usage Cache ============

const USAGE_REFRESH_INTERVAL = 5 * 60_000; // 5 minutes
const usageCache = new Map<string, UsageSnapshot>(); // keyed by provider

// ============ Env Flags ============

function parseBooleanEnv(
  value: string | undefined,
  fallback: boolean,
): boolean {
  if (value === undefined) return fallback;

  const normalized = value.trim().toLowerCase();
  if (!normalized) return fallback;

  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

export function sanitizeFooterText(value: string): string {
  return value.replace(
    /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g,
    "",
  );
}

export function abbreviateHomePath(
  cwd: string,
  home: string | undefined,
  platform = process.platform,
): string {
  if (!home) return cwd;
  const trimmedHome = home.replace(/[\\/]+$/, "") || home;
  const compareCwd = platform === "win32" ? cwd.toLowerCase() : cwd;
  const compareHome =
    platform === "win32" ? trimmedHome.toLowerCase() : trimmedHome;
  if (compareCwd === compareHome) return "~";
  if (!compareCwd.startsWith(compareHome)) return cwd;

  const boundary = cwd.slice(trimmedHome.length, trimmedHome.length + 1);
  return boundary === "/" || boundary === "\\"
    ? `~${cwd.slice(trimmedHome.length)}`
    : cwd;
}

export function buildTerminalTitle(
  sessionName: string | undefined,
  cwd: string,
): string {
  const safeSession = sanitizeFooterText(sessionName ?? "").trim();
  const safeProject = sanitizeFooterText(basename(cwd)).trim() || "pi";
  return `pi · ${safeSession || safeProject}`.slice(0, 120);
}

export function isFastServiceTierPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }

  const request = payload as Record<string, unknown>;
  const serviceTier = request.service_tier ?? request.serviceTier;
  if (typeof serviceTier !== "string") return false;

  const normalized = serviceTier.trim().toLowerCase();
  return normalized === "fast" || normalized === "priority";
}

const FAST_SERVICE_TIER_APIS = {
  openai: "openai-responses",
  "openai-codex": "openai-codex-responses",
  anthropic: "anthropic-messages",
  google: "google-generative-ai",
  "google-vertex": "google-vertex",
} as const;

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function resolveFastServiceTierState(
  model: unknown,
  defaults: unknown,
  branch: readonly unknown[],
): boolean {
  const modelRecord = recordValue(model);
  const provider = modelRecord?.provider;
  const api = modelRecord?.api;
  if (
    typeof provider !== "string" ||
    !(provider in FAST_SERVICE_TIER_APIS) ||
    api !== FAST_SERVICE_TIER_APIS[
      provider as keyof typeof FAST_SERVICE_TIER_APIS
    ]
  ) {
    return false;
  }

  let overrides: Record<string, unknown> | undefined;
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = recordValue(branch[index]);
    if (entry?.type !== "custom" || entry.customType !== "pi-service-tier") {
      continue;
    }
    const data = recordValue(entry.data);
    if (data?.version !== 1) continue;
    overrides = recordValue(data.overrides);
    if (overrides) break;
  }

  const defaultRecord = recordValue(defaults) ?? {};
  const tier =
    overrides && Object.prototype.hasOwnProperty.call(overrides, provider)
      ? overrides[provider]
      : defaultRecord[provider];
  return tier === "priority";
}

// ============ Git Cache ============

let gitCache: GitCache | null = null;

function parseGitStatus(output: string): GitCache {
  let branch: string | null = null;
  let dirty = false;
  let ahead = 0;
  let behind = 0;

  for (const line of output.split("\n")) {
    if (!line) continue;

    if (line.startsWith("# branch.head ")) {
      const head = line.slice("# branch.head ".length).trim();
      branch = head && head !== "(detached)" ? head : null;
      continue;
    }

    if (line.startsWith("# branch.ab ")) {
      const match = line.match(/^# branch\.ab \+(\d+) -(\d+)$/);
      if (match) {
        ahead = parseInt(match[1], 10) || 0;
        behind = parseInt(match[2], 10) || 0;
      }
      continue;
    }

    if (!line.startsWith("# ")) dirty = true;
  }

  return { branch, dirty, ahead, behind };
}

function sameGitCache(a: GitCache | null, b: GitCache | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.branch === b.branch &&
    a.dirty === b.dirty &&
    a.ahead === b.ahead &&
    a.behind === b.behind
  );
}

function refreshGitCache(): boolean {
  let next: GitCache | null = null;

  // Windows: execSync routes through cmd.exe, where the POSIX `2>/dev/null`
  // redirect fails and cmd prints the error straight to the console
  // (bypassing the captured pipes) — it lands on pi's input row. Use spawnSync
  // with stdio instead, which spawns git directly with no shell involved.
  try {
    const result = spawnSync("git", ["status", "--porcelain=v2", "--branch"], {
      encoding: "utf8",
      timeout: 1000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status === 0) {
      next = parseGitStatus((result.stdout ?? "").trimEnd());
    }
  } catch {
    next = null;
  }

  const changed = !sameGitCache(gitCache, next);
  gitCache = next;
  return changed;
}

// ============ Auth Loading ============

function loadAuthJson(): AuthJson {
  const authPath = join(homedir(), ".pi", "agent", "auth.json");
  try {
    if (existsSync(authPath)) {
      const parsed: unknown = JSON.parse(readFileSync(authPath, "utf-8"));
      return parsed && typeof parsed === "object" ? (parsed as AuthJson) : {};
    }
  } catch {
    return {};
  }
  return {};
}

function resolveAuthValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  if (trimmed.startsWith("!")) {
    try {
      const output = execSync(trimmed.slice(1), {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 2000,
      }).trim();
      return output || undefined;
    } catch {
      return undefined;
    }
  }

  if (/^[A-Z][A-Z0-9_]*$/.test(trimmed) && process.env[trimmed]) {
    return process.env[trimmed];
  }

  return trimmed;
}

function getApiKey(providerKey: string, envVar: string): string | undefined {
  if (process.env[envVar]) return process.env[envVar];

  const auth = loadAuthJson();
  const entry = auth[providerKey];
  if (!entry) return undefined;

  if (typeof entry === "string") {
    return resolveAuthValue(entry);
  }
  if (typeof entry !== "object") return undefined;

  const fields = entry as {
    key?: unknown;
    access?: unknown;
    refresh?: unknown;
  };
  return resolveAuthValue(fields.key ?? fields.access ?? fields.refresh);
}

function getClaudeToken(): string | undefined {
  const auth = loadAuthJson();
  if (auth.anthropic?.access) return auth.anthropic.access;

  // Fallback: Claude CLI keychain (macOS only — `security` doesn't exist on
  // Windows, and the POSIX redirect would make cmd.exe print to the console)
  if (process.platform !== "darwin") return undefined;
  try {
    const keychainData = execSync(
      'security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null',
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
    if (keychainData) {
      const parsed = JSON.parse(keychainData);
      if (parsed.claudeAiOauth?.accessToken) {
        return parsed.claudeAiOauth.accessToken;
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function getCopilotToken(): string | undefined {
  const auth = loadAuthJson();
  return auth["github-copilot"]?.refresh;
}

function getCodexToken(): { token: string; accountId?: string } | undefined {
  const auth = loadAuthJson();
  if (auth["openai-codex"]?.access) {
    return {
      token: auth["openai-codex"].access,
      accountId: auth["openai-codex"]?.accountId,
    };
  }

  // Fallback: ~/.codex/auth.json
  const codexPath = join(
    process.env.CODEX_HOME || join(homedir(), ".codex"),
    "auth.json",
  );
  try {
    if (existsSync(codexPath)) {
      const data = JSON.parse(readFileSync(codexPath, "utf-8"));
      if (data.OPENAI_API_KEY) {
        return { token: data.OPENAI_API_KEY };
      }
      if (data.tokens?.access_token) {
        return {
          token: data.tokens.access_token,
          accountId: data.tokens.account_id,
        };
      }
    }
  } catch {}

  return undefined;
}

function getGeminiToken(): string | undefined {
  const auth = loadAuthJson();
  if (auth["google-gemini-cli"]?.access)
    return auth["google-gemini-cli"].access;

  // Fallback: ~/.gemini/oauth_creds.json
  const geminiPath = join(homedir(), ".gemini", "oauth_creds.json");
  try {
    if (existsSync(geminiPath)) {
      const data = JSON.parse(readFileSync(geminiPath, "utf-8"));
      return data.access_token;
    }
  } catch {}

  return undefined;
}

function getMinimaxToken(
  provider: "minimax" | "minimax-cn",
): string | undefined {
  return provider === "minimax"
    ? getApiKey("minimax", "MINIMAX_API_KEY")
    : getApiKey("minimax-cn", "MINIMAX_CN_API_KEY");
}

function getKimiToken(): string | undefined {
  return getApiKey("kimi-coding", "KIMI_API_KEY");
}

// ============ Time Formatting ============

function formatResetTime(date: Date): string {
  const diffMs = date.getTime() - Date.now();
  if (diffMs < 0) return "now";

  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 60) return `${diffMins}m`;

  const hours = Math.floor(diffMins / 60);
  const mins = diffMins % 60;
  if (hours < 24) return mins > 0 ? `${hours}h${mins}m` : `${hours}h`;

  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours > 0 ? `${days}d${remainingHours}h` : `${days}d`;
}

/** Clamp a percentage to [0, 100]. Does NOT auto-normalize 0-1 fractions. */
function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

/** Normalize a value that might be 0-1 fraction OR 0-100 percent, then clamp. */
function normalizePercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const normalized = value <= 1 && value >= 0 ? value * 100 : value;
  return Math.max(0, Math.min(100, normalized));
}

function getWindowLabel(
  durationMs: number | undefined,
  fallback: string,
): string {
  if (!durationMs || !Number.isFinite(durationMs) || durationMs <= 0)
    return fallback;

  const hourMs = 60 * 60 * 1000;
  const dayMs = 24 * hourMs;
  const weekMs = 7 * dayMs;

  // Check if duration is close to a standard window and use the fallback label.
  // This preserves "5h" / "Week" / "Day" labels even when the actual
  // rolling window start/end times don't align perfectly.
  const isCloseToWeek = Math.abs(durationMs - weekMs) <= hourMs * 2;
  const isCloseToDay = Math.abs(durationMs - dayMs) <= hourMs * 2;
  const isCloseTo5h = Math.abs(durationMs - 5 * hourMs) <= hourMs * 2;

  if (isCloseToWeek || fallback === "Week") return "Week";
  if (isCloseToDay || fallback === "Day") return "Day";
  if (isCloseTo5h || fallback === "5h") return fallback;

  const hours = Math.round(durationMs / hourMs);
  if (hours >= 1 && hours < 48) return `${hours}h`;

  const days = Math.round(durationMs / dayMs);
  if (days >= 1) return `${days}d`;

  const mins = Math.max(1, Math.round(durationMs / 60000));
  return `${mins}m`;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = 5000,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

// ============ Usage Fetchers ============

async function fetchClaudeUsage(): Promise<UsageSnapshot> {
  const token = getClaudeToken();
  if (!token) {
    return {
      provider: "Claude",
      windows: [],
      error: "no-auth",
      fetchedAt: Date.now(),
    };
  }

  try {
    const res = await fetchWithTimeout(
      "https://api.anthropic.com/api/oauth/usage",
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "anthropic-beta": "oauth-2025-04-20",
        },
      },
    );

    if (!res.ok) {
      return {
        provider: "Claude",
        windows: [],
        error: `HTTP ${res.status}`,
        fetchedAt: Date.now(),
      };
    }

    const data = (await res.json()) as any;
    const windows: RateWindow[] = [];

    if (data.five_hour?.utilization !== undefined) {
      windows.push({
        label: "5h",
        usedPercent: normalizePercent(data.five_hour.utilization),
        resetsIn: data.five_hour.resets_at
          ? formatResetTime(new Date(data.five_hour.resets_at))
          : undefined,
      });
    }

    if (data.seven_day?.utilization !== undefined) {
      windows.push({
        label: "Week",
        usedPercent: normalizePercent(data.seven_day.utilization),
        resetsIn: data.seven_day.resets_at
          ? formatResetTime(new Date(data.seven_day.resets_at))
          : undefined,
      });
    }

    return { provider: "Claude", windows, fetchedAt: Date.now() };
  } catch (e) {
    return {
      provider: "Claude",
      windows: [],
      error: String(e),
      fetchedAt: Date.now(),
    };
  }
}

async function fetchCopilotUsage(): Promise<UsageSnapshot> {
  const token = getCopilotToken();
  if (!token) {
    return {
      provider: "Copilot",
      windows: [],
      error: "no-auth",
      fetchedAt: Date.now(),
    };
  }

  try {
    const res = await fetchWithTimeout(
      "https://api.github.com/copilot_internal/user",
      {
        headers: {
          "Editor-Version": "vscode/1.96.2",
          "User-Agent": "GitHubCopilotChat/0.26.7",
          "X-Github-Api-Version": "2025-04-01",
          Accept: "application/json",
          Authorization: `token ${token}`,
        },
      },
    );

    if (!res.ok) {
      return {
        provider: "Copilot",
        windows: [],
        error: `HTTP ${res.status}`,
        fetchedAt: Date.now(),
      };
    }

    const data = (await res.json()) as any;
    const windows: RateWindow[] = [];

    const resetDate = data.quota_reset_date_utc
      ? new Date(data.quota_reset_date_utc)
      : undefined;
    const resetsIn = resetDate ? formatResetTime(resetDate) : undefined;

    if (data.quota_snapshots?.premium_interactions) {
      const pi = data.quota_snapshots.premium_interactions;
      const usedPercent = clampPercent(100 - (pi.percent_remaining || 0));
      windows.push({ label: "Premium", usedPercent, resetsIn });
    }

    if (data.quota_snapshots?.chat && !data.quota_snapshots.chat.unlimited) {
      const chat = data.quota_snapshots.chat;
      windows.push({
        label: "Chat",
        usedPercent: clampPercent(100 - (chat.percent_remaining || 0)),
        resetsIn,
      });
    }

    return { provider: "Copilot", windows, fetchedAt: Date.now() };
  } catch (e) {
    return {
      provider: "Copilot",
      windows: [],
      error: String(e),
      fetchedAt: Date.now(),
    };
  }
}

async function fetchCodexUsage(): Promise<UsageSnapshot> {
  const creds = getCodexToken();
  if (!creds) {
    return {
      provider: "Codex",
      windows: [],
      error: "no-auth",
      fetchedAt: Date.now(),
    };
  }

  const providerLabel = "Codex";

  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${creds.token}`,
      "User-Agent": "pi-agent",
      Accept: "application/json",
    };

    if (creds.accountId) {
      headers["ChatGPT-Account-Id"] = creds.accountId;
    }

    const res = await fetchWithTimeout(
      "https://chatgpt.com/backend-api/wham/usage",
      {
        method: "GET",
        headers,
      },
    );

    if (!res.ok) {
      return {
        provider: providerLabel,
        windows: [],
        error: `HTTP ${res.status}`,
        fetchedAt: Date.now(),
      };
    }

    const data = (await res.json()) as any;
    const windows: RateWindow[] = [];

    if (data.rate_limit?.primary_window) {
      const pw = data.rate_limit.primary_window;
      const resetDate = pw.reset_at ? new Date(pw.reset_at * 1000) : undefined;
      const durationMs =
        typeof pw.limit_window_seconds === "number"
          ? pw.limit_window_seconds * 1000
          : undefined;
      windows.push({
        label: getWindowLabel(durationMs, "5h"),
        usedPercent: clampPercent(pw.used_percent || 0),
        resetsIn: resetDate ? formatResetTime(resetDate) : undefined,
      });
    }

    if (data.rate_limit?.secondary_window) {
      const sw = data.rate_limit.secondary_window;
      const resetDate = sw.reset_at ? new Date(sw.reset_at * 1000) : undefined;
      const durationMs =
        typeof sw.limit_window_seconds === "number"
          ? sw.limit_window_seconds * 1000
          : undefined;
      windows.push({
        label: getWindowLabel(durationMs, "Week"),
        usedPercent: clampPercent(sw.used_percent || 0),
        resetsIn: resetDate ? formatResetTime(resetDate) : undefined,
      });
    }

    return { provider: providerLabel, windows, fetchedAt: Date.now() };
  } catch (e) {
    return {
      provider: providerLabel,
      windows: [],
      error: String(e),
      fetchedAt: Date.now(),
    };
  }
}

async function fetchGeminiUsage(): Promise<UsageSnapshot> {
  const token = getGeminiToken();
  if (!token) {
    return {
      provider: "Gemini",
      windows: [],
      error: "no-auth",
      fetchedAt: Date.now(),
    };
  }

  try {
    const res = await fetchWithTimeout(
      "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      },
    );

    if (!res.ok) {
      return {
        provider: "Gemini",
        windows: [],
        error: `HTTP ${res.status}`,
        fetchedAt: Date.now(),
      };
    }

    const data = (await res.json()) as any;
    const quotas: Record<string, number> = {};

    for (const bucket of data.buckets || []) {
      const model = bucket.modelId || "unknown";
      const frac = bucket.remainingFraction ?? 1;
      if (quotas[model] === undefined || frac < quotas[model]) {
        quotas[model] = frac;
      }
    }

    const windows: RateWindow[] = [];
    let proMin = 1,
      flashMin = 1;
    let hasProModel = false,
      hasFlashModel = false;

    for (const [model, frac] of Object.entries(quotas)) {
      if (model.toLowerCase().includes("pro")) {
        hasProModel = true;
        if (frac < proMin) proMin = frac;
      }
      if (model.toLowerCase().includes("flash")) {
        hasFlashModel = true;
        if (frac < flashMin) flashMin = frac;
      }
    }

    if (hasProModel)
      windows.push({
        label: "Pro",
        usedPercent: clampPercent((1 - proMin) * 100),
      });
    if (hasFlashModel)
      windows.push({
        label: "Flash",
        usedPercent: clampPercent((1 - flashMin) * 100),
      });

    return { provider: "Gemini", windows, fetchedAt: Date.now() };
  } catch (e) {
    return {
      provider: "Gemini",
      windows: [],
      error: String(e),
      fetchedAt: Date.now(),
    };
  }
}

async function fetchMinimaxUsage(
  provider: "minimax" | "minimax-cn",
): Promise<UsageSnapshot> {
  const token = getMinimaxToken(provider);
  const providerLabel = provider === "minimax-cn" ? "MiniMax CN" : "MiniMax";
  // Docs-recommended Token Plan endpoint. The legacy /coding_plan/remains path
  // still works but the response field names differ from the current UI.
  const endpoint =
    provider === "minimax-cn"
      ? "https://api.minimaxi.com/v1/token_plan/remains"
      : "https://api.minimax.io/v1/token_plan/remains";

  if (!token) {
    return {
      provider: providerLabel,
      windows: [],
      error: "no-auth",
      fetchedAt: Date.now(),
    };
  }

  try {
    const res = await fetchWithTimeout(endpoint, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      return {
        provider: providerLabel,
        windows: [],
        error: `HTTP ${res.status}`,
        fetchedAt: Date.now(),
      };
    }

    const data = (await res.json()) as any;
    const baseResp = data?.base_resp;
    if (baseResp?.status_code && baseResp.status_code !== 0) {
      return {
        provider: providerLabel,
        windows: [],
        error: baseResp.status_msg || `API ${baseResp.status_code}`,
        fetchedAt: Date.now(),
      };
    }

    const remains = Array.isArray(data?.model_remains)
      ? data.model_remains
      : [];
    // Token Plan returns one bucket per capability (general = text/code, video, etc.).
    // Prefer the active "general" bucket since M-series chat models land there.
    // status === 1 = window is active/limiting, 3 = inactive (no usage). Fall back
    // to the first active bucket, then the first bucket of any kind.
    const textBucket =
      remains.find(
        (entry: any) =>
          entry?.model_name === "general" &&
          Number(entry?.current_interval_status) === 1,
      ) ||
      remains.find((entry: any) => entry?.model_name === "general") ||
      remains.find(
        (entry: any) => Number(entry?.current_interval_status) === 1,
      ) ||
      remains[0];

    if (!textBucket) {
      return {
        provider: providerLabel,
        windows: [],
        error: "no-usage-data",
        fetchedAt: Date.now(),
      };
    }

    const windows: RateWindow[] = [];

    // Source of truth: *_remaining_percent (the *_total_count / *_usage_count
    // fields are zeroed in the credit-based model and cannot be used to compute
    // a fraction). The UI usage bar maps 100 - remainingPercent -> used.
    const intervalRemaining = Number(
      textBucket.current_interval_remaining_percent,
    );
    if (Number.isFinite(intervalRemaining)) {
      const usedPercent = clampPercent(100 - intervalRemaining);
      const resetDate = textBucket.end_time
        ? new Date(Number(textBucket.end_time))
        : undefined;
      const durationMs =
        textBucket.start_time && textBucket.end_time
          ? Number(textBucket.end_time) - Number(textBucket.start_time)
          : undefined;
      windows.push({
        label: getWindowLabel(durationMs, "5h"),
        usedPercent,
        resetsIn: resetDate ? formatResetTime(resetDate) : undefined,
      });
    }

    const weeklyRemaining = Number(textBucket.current_weekly_remaining_percent);
    if (Number.isFinite(weeklyRemaining)) {
      const usedPercent = clampPercent(100 - weeklyRemaining);
      const resetDate = textBucket.weekly_end_time
        ? new Date(Number(textBucket.weekly_end_time))
        : undefined;
      const durationMs =
        textBucket.weekly_start_time && textBucket.weekly_end_time
          ? Number(textBucket.weekly_end_time) -
            Number(textBucket.weekly_start_time)
          : undefined;
      windows.push({
        label: getWindowLabel(durationMs, "Week"),
        usedPercent,
        resetsIn: resetDate ? formatResetTime(resetDate) : undefined,
      });
    }

    if (windows.length === 0) {
      return {
        provider: providerLabel,
        windows: [],
        error: "no-usage-data",
        fetchedAt: Date.now(),
      };
    }

    return { provider: providerLabel, windows, fetchedAt: Date.now() };
  } catch (e) {
    return {
      provider: providerLabel,
      windows: [],
      error: String(e),
      fetchedAt: Date.now(),
    };
  }
}

async function fetchKimiUsage(): Promise<UsageSnapshot> {
  const token = getKimiToken();
  const endpoint = "https://api.kimi.com/coding/v1/usages";
  if (!token) {
    return {
      provider: "Kimi Coding",
      windows: [],
      error: "no-auth",
      fetchedAt: Date.now(),
    };
  }

  try {
    const res = await fetchWithTimeout(endpoint, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      return {
        provider: "Kimi Coding",
        windows: [],
        error: `HTTP ${res.status}`,
        fetchedAt: Date.now(),
      };
    }

    const data = (await res.json()) as any;
    const windows: RateWindow[] = [];

    for (const limit of data.limits || []) {
      const windowLimit = Number(limit.detail?.limit) || 0;
      const windowRemaining = Number(limit.detail?.remaining) || 0;
      if (windowLimit > 0) {
        const used = windowLimit - windowRemaining;
        const usedPercent = clampPercent((used / windowLimit) * 100);
        const resetDate = limit.detail?.resetTime
          ? new Date(limit.detail.resetTime)
          : undefined;
        const durationMs =
          limit.window?.duration &&
          limit.window?.timeUnit === "TIME_UNIT_MINUTE"
            ? limit.window.duration * 60 * 1000
            : undefined;

        windows.push({
          label: getWindowLabel(durationMs, "5h"),
          usedPercent,
          resetsIn: resetDate ? formatResetTime(resetDate) : undefined,
        });
      }
    }

    const weeklyLimit = Number(data.usage?.limit) || 0;
    const weeklyRemaining = Number(data.usage?.remaining) || 0;
    const weeklyResetTime = data.usage?.resetTime;

    if (weeklyLimit > 0) {
      const used = weeklyLimit - weeklyRemaining;
      const usedPercent = clampPercent((used / weeklyLimit) * 100);
      windows.push({
        label: "Weekly",
        usedPercent,
        resetsIn: weeklyResetTime
          ? formatResetTime(new Date(weeklyResetTime))
          : undefined,
      });
    }

    return { provider: "Kimi Coding", windows, fetchedAt: Date.now() };
  } catch (e) {
    return {
      provider: "Kimi Coding",
      windows: [],
      error: String(e),
      fetchedAt: Date.now(),
    };
  }
}

// ============ CommandCode Usage ============

function nonEmptyCredential(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

/**
 * Resolve only CommandCode-scoped credentials from a parsed auth file.
 * A generic root apiKey is accepted exclusively for CommandCode's own file;
 * shared multi-provider stores must use provider-scoped fields.
 */
export function resolveCommandCodeCredential(
  parsed: unknown,
  allowGenericApiKey = false,
): string | undefined {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }

  const auth = parsed as Record<string, unknown>;
  if (allowGenericApiKey) {
    const generic = nonEmptyCredential(auth.apiKey);
    if (generic) return generic;
  }

  const commandcode = auth.commandcode;
  const direct = nonEmptyCredential(commandcode);
  if (direct) return direct;
  if (commandcode && typeof commandcode === "object") {
    const access = nonEmptyCredential(
      (commandcode as Record<string, unknown>).access,
    );
    if (access) return access;
  }

  const official = auth["command-code"];
  if (official && typeof official === "object") {
    const key = nonEmptyCredential(
      (official as Record<string, unknown>).key,
    );
    if (key) return key;
  }

  return undefined;
}

function getCommandCodeApiKey(): string | undefined {
  if (process.env.COMMANDCODE_API_KEY) return process.env.COMMANDCODE_API_KEY;

  const authSources = [
    {
      path: join(homedir(), ".commandcode", "auth.json"),
      allowGenericApiKey: true,
    },
    {
      path: join(homedir(), ".pi", "agent", "auth.json"),
      allowGenericApiKey: false,
    },
    {
      path: join(homedir(), ".omp", "agent", "auth.json"),
      allowGenericApiKey: false,
    },
  ];

  for (const source of authSources) {
    try {
      if (!existsSync(source.path)) continue;
      const parsed: unknown = JSON.parse(readFileSync(source.path, "utf-8"));
      const credential = resolveCommandCodeCredential(
        parsed,
        source.allowGenericApiKey,
      );
      if (credential) return credential;
    } catch {}
  }
  return undefined;
}

async function fetchCommandCodeUsage(): Promise<UsageSnapshot> {
  const apiKey = getCommandCodeApiKey();
  if (!apiKey) {
    return {
      provider: "CommandCode",
      windows: [],
      error: "no-auth",
      fetchedAt: Date.now(),
    };
  }

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "x-command-code-version": "0.29.0",
    "x-cli-environment": "production",
  };

  try {
    // 1. whoami to get orgId
    const whoamiRes = await fetchWithTimeout(
      "https://api.commandcode.ai/alpha/whoami",
      { headers },
    );
    if (!whoamiRes.ok) {
      return {
        provider: "CommandCode",
        windows: [],
        error: `HTTP ${whoamiRes.status}`,
        fetchedAt: Date.now(),
      };
    }
    const whoami = (await whoamiRes.json()) as any;
    const orgId: string | null = whoami?.org?.id ?? null;

    // Build query suffix only when orgId is present
    const orgParam = orgId ? `?orgId=${encodeURIComponent(orgId)}` : "";

    // 2. credits + usage summary in parallel
    const [creditsRes, summaryRes] = await Promise.all([
      fetchWithTimeout(
        `https://api.commandcode.ai/alpha/billing/credits${orgParam}`,
        { headers },
      ),
      fetchWithTimeout(
        `https://api.commandcode.ai/alpha/usage/summary${orgParam}`,
        { headers },
      ),
    ]);

    if (!creditsRes.ok || !summaryRes.ok) {
      return {
        provider: "CommandCode",
        windows: [],
        error: `HTTP ${creditsRes.status}/${summaryRes.status}`,
        fetchedAt: Date.now(),
      };
    }

    const credits = (await creditsRes.json()) as any;
    const summary = (await summaryRes.json()) as any;

    const windows: RateWindow[] = [];

    // Total credits: monthly + purchased + free
    const totalCredits =
      Math.max(0, credits?.credits?.monthlyCredits ?? 0) +
      Math.max(0, credits?.credits?.purchasedCredits ?? 0) +
      Math.max(0, credits?.credits?.freeCredits ?? 0);

    // Spent so far this period
    const spent = Math.max(0, summary?.totalCost ?? 0);

    if (totalCredits > 0) {
      const total = spent + totalCredits;
      const usedPercent = clampPercent((spent / total) * 100);
      const label = `$${spent.toFixed(2)}/$${total.toFixed(0)}`;
      windows.push({ label, usedPercent });
    }

    // Per-window limits: {fiveHour: {used, cap}, weekly: {used, cap}}
    const limits = credits?.windowLimits;
    if (limits && typeof limits === "object" && !Array.isArray(limits)) {
      const labelMap: Record<string, string> = {
        fiveHour: "5h",
        weekly: "Week",
      };
      for (const [key, wl] of Object.entries(limits)) {
        if (!wl || typeof wl !== "object") continue;
        const cap = Number((wl as any).cap) || 0;
        const used = Number((wl as any).used) || 0;
        if (cap > 0) {
          windows.push({
            label: labelMap[key] ?? key,
            usedPercent: clampPercent((used / cap) * 100),
          });
        }
      }
    }

    return { provider: "CommandCode", windows, fetchedAt: Date.now() };
  } catch (e) {
    return {
      provider: "CommandCode",
      windows: [],
      error: String(e),
      fetchedAt: Date.now(),
    };
  }
}

async function fetchOpenRouterUsage(): Promise<UsageSnapshot> {
  const apiKey = getApiKey("openrouter", "OPENROUTER_API_KEY");
  const providerLabel = "OpenRouter";
  if (!apiKey) {
    return {
      provider: providerLabel,
      windows: [],
      error: "no-auth",
      fetchedAt: Date.now(),
    };
  }

  try {
    // Account-level credit balance: total_credits - total_usage = remaining.
    const res = await fetchWithTimeout("https://openrouter.ai/api/v1/credits", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!res.ok) {
      return {
        provider: providerLabel,
        windows: [],
        error: `HTTP ${res.status}`,
        fetchedAt: Date.now(),
      };
    }

    const data = (await res.json()) as any;
    const totalCredits = Number(data?.data?.total_credits);
    const used = Number(data?.data?.total_usage);

    if (!Number.isFinite(totalCredits) || !Number.isFinite(used)) {
      return {
        provider: providerLabel,
        windows: [],
        error: "no-usage-data",
        fetchedAt: Date.now(),
      };
    }

    // Match the dashboard's "Total available" number: remaining pay-as-you-go
    // balance = total credits ever purchased - total usage.
    const remaining = Math.max(0, totalCredits - used);
    const windows: RateWindow[] = [
      {
        label: `$${remaining.toFixed(2)} left`,
        usedPercent: clampPercent(
          (Math.max(0, used) / Math.max(totalCredits, 0.01)) * 100,
        ),
      },
    ];

    return { provider: providerLabel, windows, fetchedAt: Date.now() };
  } catch (e) {
    return {
      provider: providerLabel,
      windows: [],
      error: String(e),
      fetchedAt: Date.now(),
    };
  }
}

// ============ Provider Cost Accounting (OpenCode Zen / Go) ============
// Neither OpenCode Zen nor Go exposes usage/balance over their API keys
// (the console dashboard is OAuth-only; the chat API returns no quota
// headers). Instead we sum pi's per-message dollar cost recorded in session
// files. Caveats: counts pi usage only (opencode CLI usage on the same key
// is invisible). Go's monthly limit resets on the subscription anniversary
// (unknowable), so only 5h + calendar-week (UTC Monday) windows are shown;
// Zen is pay-per-use so we show spend over the last 30 days.

const COST_SESSION_ROOT = join(homedir(), ".pi", "agent", "sessions");
const COST_SCAN_AGE_MS = 32 * 24 * 60 * 60 * 1000; // covers the 30-day display + slack
const GO_LIMITS: Record<string, number> = { "5h": 12, Week: 30 }; // USD

const costFileCache = new Map<
  string,
  {
    size: number;
    mtimeMs: number;
    pairs: Array<{ ts: number; cost: number; provider: string }>;
  }
>();

async function collectProviderCosts(
  provider: string,
): Promise<Array<{ ts: number; cost: number }>> {
  const cutoff = Date.now() - COST_SCAN_AGE_MS;
  const out: Array<{ ts: number; cost: number }> = [];

  try {
    for (const rel of await readdirAsync(COST_SESSION_ROOT, {
      recursive: true,
    })) {
      if (typeof rel !== "string" || !rel.endsWith(".jsonl")) continue;
      const path = join(COST_SESSION_ROOT, rel);
      const st = await statAsync(path);
      if (st.mtimeMs < cutoff) continue;

      const cached = costFileCache.get(path);
      if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
        for (const p of cached.pairs) {
          if (p.provider === provider) out.push({ ts: p.ts, cost: p.cost });
        }
        continue;
      }

      const pairs: Array<{ ts: number; cost: number; provider: string }> = [];
      for (const line of (await readFileAsync(path, "utf8")).split("\n")) {
        if (!line) continue;
        try {
          const e = JSON.parse(line);
          const m = e?.message;
          if (e?.type === "message" && m?.role === "assistant") {
            const ts = m.timestamp;
            const cost = m.usage?.cost?.total;
            if (
              typeof ts === "number" &&
              typeof cost === "number" &&
              typeof m.provider === "string"
            ) {
              pairs.push({ ts, cost, provider: m.provider });
            }
          }
        } catch {}
      }
      costFileCache.set(path, { size: st.size, mtimeMs: st.mtimeMs, pairs });
      for (const p of pairs) {
        if (p.provider === provider) out.push({ ts: p.ts, cost: p.cost });
      }
    }
  } catch {
    return out;
  }

  return out;
}

function weekStartUtcMs(now: number): number {
  const d = new Date(now);
  const mondayOffset = (d.getUTCDay() + 6) % 7; // Monday = 0
  return Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate() - mondayOffset,
  );
}

async function fetchOpenCodeGoUsage(): Promise<UsageSnapshot> {
  const costs = await collectProviderCosts("opencode-go");
  const now = Date.now();
  const sumSince = (since: number) =>
    costs.reduce((acc, c) => (c.ts >= since ? acc + c.cost : acc), 0);
  const windows: RateWindow[] = [];

  const fiveStart = now - 5 * 3600 * 1000;
  const fiveCosts = costs.filter((c) => c.ts >= fiveStart);
  const fiveEnd =
    (fiveCosts.length ? Math.max(...fiveCosts.map((c) => c.ts)) : fiveStart) +
    5 * 3600 * 1000;
  windows.push({
    label: "5h",
    usedPercent: clampPercent((sumSince(fiveStart) / GO_LIMITS["5h"]) * 100),
    resetsIn: formatResetTime(new Date(fiveEnd)),
  });

  const weekStart = weekStartUtcMs(now);
  windows.push({
    label: "Week",
    usedPercent: clampPercent((sumSince(weekStart) / GO_LIMITS.Week) * 100),
    resetsIn: formatResetTime(new Date(weekStart + 7 * 24 * 3600 * 1000)),
  });

  return { provider: "OpenCode Go", windows, fetchedAt: now };
}

async function fetchOpenCodeZenUsage(): Promise<UsageSnapshot> {
  const now = Date.now();
  const cutoff = now - 30 * 24 * 60 * 60 * 1000;
  const costs = await collectProviderCosts("opencode");
  const spent = costs.reduce(
    (acc, c) => (c.ts >= cutoff ? acc + c.cost : acc),
    0,
  );
  return {
    provider: "OpenCode Zen",
    windows: [{ label: `$${spent.toFixed(2)} spent`, usedPercent: 0 }],
    fetchedAt: Date.now(),
  };
}

// ============ Provider Detection ============

// Map pi provider names to our internal usage provider keys
const PROVIDER_MAP: Record<string, string> = {
  anthropic: "claude", // Claude Max subscription
  "openai-codex": "codex", // Codex subscription
  "github-copilot": "copilot", // Copilot subscription
  "google-gemini-cli": "gemini", // Gemini CLI subscription
  minimax: "minimax", // MiniMax Token Plan / Coding Plan
  "minimax-cn": "minimax-cn", // MiniMax China plan
  "kimi-coding": "kimi-coding", // Kimi plan
  commandcode: "commandcode", // Command Code API
  opencode: "opencode-zen", // OpenCode Zen pay-per-use
  "opencode-go": "opencode-go", // OpenCode Go subscription
  openrouter: "openrouter", // OpenRouter credits
};

function detectProvider(modelProvider: string): string | null {
  return PROVIDER_MAP[modelProvider] || null;
}

async function fetchUsageForProvider(provider: string): Promise<UsageSnapshot> {
  switch (provider) {
    case "claude":
      return fetchClaudeUsage();
    case "codex":
      return fetchCodexUsage();
    case "copilot":
      return fetchCopilotUsage();
    case "gemini":
      return fetchGeminiUsage();
    case "minimax":
      return fetchMinimaxUsage("minimax");
    case "minimax-cn":
      return fetchMinimaxUsage("minimax-cn");
    case "kimi-coding":
      return fetchKimiUsage();
    case "commandcode":
      return fetchCommandCodeUsage();
    case "opencode-go":
      return fetchOpenCodeGoUsage();
    case "opencode-zen":
      return fetchOpenCodeZenUsage();
    case "openrouter":
      return fetchOpenRouterUsage();
    default:
      return {
        provider: "Unknown",
        windows: [],
        error: "unknown-provider",
        fetchedAt: Date.now(),
      };
  }
}

// ============ Extension ============

export default function (pi: ExtensionAPI) {
  const CTX_GAUGE_WIDTH = 10;

  // Segmented square bars inspired by claude-hud.
  const BAR_FILLED = "■";
  const BAR_EMPTY = "■";

  // Optional visibility toggles (default: enabled)
  const showSessionName = parseBooleanEnv(
    process.env.PI_MINIMAL_FOOTER_SHOW_SESSION_NAME,
    true,
  );
  const showCwd = parseBooleanEnv(process.env.PI_MINIMAL_FOOTER_SHOW_CWD, true);
  const showBranch = parseBooleanEnv(
    process.env.PI_MINIMAL_FOOTER_SHOW_BRANCH,
    true,
  );
  const showWorkStatus = parseBooleanEnv(
    process.env.PI_MINIMAL_FOOTER_SHOW_WORK_STATUS,
    true,
  );
  const setTerminalTitle = parseBooleanEnv(
    process.env.PI_MINIMAL_FOOTER_SET_TERMINAL_TITLE,
    true,
  );

  function formatTokenCount(tokens: number): string {
    if (tokens >= 1_000_000) {
      const m = tokens / 1_000_000;
      return m % 1 === 0 ? `${m}M` : `${m.toFixed(1).replace(/\.0$/, "")}M`;
    }
    if (tokens >= 1_000) {
      return `${Math.round(tokens / 1_000)}k`;
    }
    return `${tokens}`;
  }

  function fitFooterSegment(width: number, variants: string[]): string {
    const safeWidth = Math.max(1, width);

    for (const variant of variants) {
      if (visibleWidth(variant) <= safeWidth) return variant;
    }

    return truncateToWidth(variants[variants.length - 1] || "", safeWidth);
  }

  type HeaderTone = "model" | "thinking" | "dir" | "git" | "session";
  type ProgressTone = "green" | "yellow" | "red";

  const HEADER_COLORS = {
    model: { rgb: [34, 211, 238], ansi256: 81 },
    thinking: { rgb: [187, 154, 247], ansi256: 141 },
    dir: { rgb: [125, 207, 255], ansi256: 117 },
    git: { rgb: [224, 175, 104], ansi256: 179 },
    session: { rgb: [74, 222, 128], ansi256: 78 },
  } as const;

  const PROGRESS_COLORS = {
    green: { rgb: [34, 197, 94], ansi256: 77 },
    yellow: { rgb: [250, 204, 21], ansi256: 220 },
    red: { rgb: [239, 68, 68], ansi256: 203 },
  } as const;
  const NORMAL_INTENSITY = "\u001b[22m";

  function headerColor(tone: HeaderTone, text: string, theme: any): string {
    const color = HEADER_COLORS[tone];
    const safeText = sanitizeFooterText(text);
    const ansi =
      theme.getColorMode() === "256color"
        ? `\u001b[38;5;${color.ansi256}m`
        : `\u001b[38;2;${color.rgb[0]};${color.rgb[1]};${color.rgb[2]}m`;
    return `${NORMAL_INTENSITY}${ansi}${safeText}\u001b[39m`;
  }

  function getProgressTone(percentage: number): ProgressTone {
    if (percentage >= 75) return "red";
    if (percentage >= 50) return "yellow";
    return "green";
  }

  function progressColor(percentage: number, text: string, theme: any): string {
    const color = PROGRESS_COLORS[getProgressTone(percentage)];
    const ansi =
      theme.getColorMode() === "256color"
        ? `\u001b[38;5;${color.ansi256}m`
        : `\u001b[38;2;${color.rgb[0]};${color.rgb[1]};${color.rgb[2]}m`;
    return `${NORMAL_INTENSITY}${ansi}${text}\u001b[39m`;
  }

  function renderContextGauge(
    percentage: number,
    theme: any,
    used?: number,
    total?: number,
    options?: {
      barWidth?: number;
      includeCounts?: boolean;
      estimated?: boolean;
    },
  ): string {
    const barWidth = Math.max(4, options?.barWidth ?? CTX_GAUGE_WIDTH);
    const clamped = Math.max(0, Math.min(100, percentage));
    const filled = Math.round((clamped / 100) * barWidth);
    const empty = barWidth - filled;

    const bar =
      progressColor(clamped, BAR_FILLED.repeat(filled), theme) +
      theme.fg("borderMuted", BAR_EMPTY.repeat(empty));
    const estimatePrefix = options?.estimated ? "~" : "";
    const pct = `${estimatePrefix}${Math.round(clamped)}%`;
    const counts =
      options?.includeCounts === false || used === undefined || !total
        ? ""
        : ` (${estimatePrefix}${formatTokenCount(used)}/${formatTokenCount(total)})`;

    return `${theme.fg("text", "context")} ${bar} ${progressColor(clamped, pct, theme)}${theme.fg("dim", counts)}`;
  }

  function renderUsageBar(
    usedPercent: number,
    barWidth: number,
    theme: any,
  ): string {
    const clamped = Math.max(0, Math.min(100, usedPercent));
    const filled = Math.round((clamped / 100) * barWidth);
    const empty = barWidth - filled;

    return (
      progressColor(clamped, BAR_FILLED.repeat(filled), theme) +
      theme.fg("borderMuted", BAR_EMPTY.repeat(empty))
    );
  }

  function renderUsageWindow(
    window: RateWindow,
    theme: any,
    options?: { barWidth?: number; includeReset?: boolean },
  ): string {
    const bar = renderUsageBar(
      window.usedPercent,
      Math.max(4, options?.barWidth ?? 10),
      theme,
    );
    const pct = progressColor(
      window.usedPercent,
      `${Math.round(window.usedPercent)}%`,
      theme,
    );
    const timeStr =
      options?.includeReset === false || !window.resetsIn
        ? ""
        : ` ${theme.fg("dim", `(reset ${window.resetsIn})`)}`;
    return `${theme.fg("text", window.label)} ${bar} ${pct}${timeStr}`;
  }

  function renderProviderUsage(usage: UsageSnapshot, theme: any): string {
    const weeklyWindow = usage.windows.find((window) =>
      window.label.toLowerCase().includes("week"),
    );
    const selectedWindow =
      weeklyWindow ??
      usage.windows.reduce<RateWindow | undefined>(
        (selected, window) =>
          !selected || window.usedPercent > selected.usedPercent
            ? window
            : selected,
        undefined,
      );
    if (!selectedWindow) return "";

    return renderUsageWindow(
      weeklyWindow ? { ...selectedWindow, label: "weekly" } : selectedWindow,
      theme,
      {
        barWidth: 10,
        includeReset: true,
      },
    );
  }

  function getSessionFooterState(ctx: any): {
    thinkingLevel: string;
    percentage: number;
    used: number;
    total: number;
    estimated: boolean;
  } {
    const entries = ctx.sessionManager.getEntries();
    const leafId = ctx.sessionManager.getLeafId();
    const context = buildSessionContext(entries, leafId);
    const reported = ctx.getContextUsage?.();
    const contextWindow =
      reported?.contextWindow ?? ctx.model?.contextWindow ?? 0;
    const base = {
      thinkingLevel: context.thinkingLevel || "off",
      percentage: 0,
      used: 0,
      total: contextWindow,
      estimated: false,
    };
    if (contextWindow === 0) return base;

    if (typeof reported?.tokens === "number") {
      return {
        ...base,
        percentage:
          typeof reported.percent === "number"
            ? reported.percent
            : (reported.tokens / contextWindow) * 100,
        used: reported.tokens,
      };
    }

    // Pi intentionally reports unknown usage immediately after compaction,
    // because no provider response has measured the compacted context yet.
    // Sum the compacted context with Pi's conservative chars/4 estimator and
    // mark it with `~`; the next assistant usage replaces it automatically.
    if (reported?.tokens === null) {
      const estimatedTokens = context.messages.reduce(
        (total: number, message: any) => total + estimateTokens(message),
        0,
      );
      return {
        ...base,
        percentage: (estimatedTokens / contextWindow) * 100,
        used: estimatedTokens,
        estimated: true,
      };
    }

    // Compatibility fallback for older Pi versions without getContextUsage().
    const lastAssistant = context.messages
      .slice()
      .reverse()
      .find(
        (message: any) =>
          message.role === "assistant" && message.stopReason !== "aborted",
      ) as any;
    const usage = lastAssistant?.usage;
    if (!usage) return base;

    const contextTokens =
      (usage.input ?? 0) +
      (usage.output ?? 0) +
      (usage.cacheRead ?? 0) +
      (usage.cacheWrite ?? 0);
    return {
      ...base,
      percentage: (contextTokens / contextWindow) * 100,
      used: contextTokens,
    };
  }

  // Track usage state for rendering
  let latestUsage: UsageSnapshot | null = null;
  let activeProvider: string | null = null; // internal provider key for the current model
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let fastModeActive = false;
  let activeContext: any | null = null;

  // Store tui reference for triggering re-renders from event handlers
  let tuiRef: { requestRender: () => void } | null = null;

  const activeTools = new Map<string, ActiveToolStatus>();
  let fleetSummary: SubagentFleetSummary | null = null;
  let subagentRpcAvailable = false;
  let fleetRequestInFlight = false;
  let fleetUpdatedAt = 0;
  let fleetConsecutiveFailures = 0;
  let footerAttached = false;
  let workRenderTimer: ReturnType<typeof setInterval> | null = null;
  let fleetRefreshTimer: ReturnType<typeof setInterval> | null = null;
  let terminalTitleTimer: ReturnType<typeof setTimeout> | null = null;
  let sessionGeneration = 0;
  let sessionActive = false;
  const FLEET_STALE_AFTER_MS = 6000;
  const SUBAGENT_RPC_TIMEOUT_MS = 1500;
  const MAX_FLEET_REFRESH_RETRIES = 3;

  const SUBAGENT_RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
  const SUBAGENT_RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";
  const SUBAGENT_RPC_READY_EVENT = "subagents:rpc:v1:ready";
  const SUBAGENT_ASYNC_STARTED_EVENT = "subagent:async-started";
  const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";
  const SUBAGENT_TOOL_NAMES = new Set([
    "subagent",
    "subagent_wait",
    "subagent_supervisor",
  ]);

  function activeMainTools(): ActiveToolStatus[] {
    return [...activeTools.values()].filter(
      (tool) =>
        !subagentRpcAvailable || !SUBAGENT_TOOL_NAMES.has(tool.toolName),
    );
  }

  function sanitizeToolName(name: string): string {
    const normalized = name.replace(/[^a-zA-Z0-9_.:-]/g, "");
    return normalized || "tool";
  }

  function formatElapsed(startedAt: number): string {
    const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m${seconds % 60}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h${minutes % 60}m`;
  }

  function renderWorkStatus(width: number, theme: any): string {
    if (!showWorkStatus) return "";

    const tools = activeMainTools();
    const segments: string[] = [];
    const compact: string[] = [];
    const sep = theme.fg("text", " │ ");

    if (tools.length === 1) {
      const tool = tools[0];
      segments.push(
        theme.fg("text", "task: ") +
          progressColor(0, sanitizeToolName(tool.toolName), theme) +
          theme.fg("dim", ` · ${formatElapsed(tool.startedAt)}`),
      );
      compact.push(theme.fg("text", "task 1"));
    } else if (tools.length > 1) {
      const names = [
        ...new Set(tools.map((tool) => sanitizeToolName(tool.toolName))),
      ];
      segments.push(
        theme.fg("text", `tasks: ${tools.length} · `) +
          progressColor(0, names.slice(0, 3).join(", "), theme) +
          (names.length > 3 ? theme.fg("dim", ` +${names.length - 3}`) : ""),
      );
      compact.push(theme.fg("text", `tasks ${tools.length}`));
    }

    const activeAgents = fleetSummary?.activeAgents ?? 0;
    const totalAgents = fleetSummary?.totalAgents ?? 0;
    if (totalAgents > 0) {
      const progress = `${activeAgents}/${totalAgents}`;
      const labelCounts = new Map<string, number>();
      for (const label of fleetSummary?.agentLabels ?? []) {
        labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
      }
      const labels = [...labelCounts.entries()]
        .slice(0, 3)
        .map(([label, count]) => `${label}${count > 1 ? ` ×${count}` : ""}`)
        .join(", ");
      const running =
        labels && activeAgents > 0
          ? theme.fg(
              "dim",
              ` · ${labels}${activeAgents === 1 ? " running" : ""}`,
            )
          : "";
      segments.push(
        theme.fg("text", "agents: ") +
          progressColor(0, progress, theme) +
          running,
      );
      compact.push(theme.fg("text", `agents ${progress}`));
    }

    const backgroundUsed = fleetSummary?.backgroundUsed ?? 0;
    const backgroundLimit = fleetSummary?.backgroundLimit ?? 0;
    if (backgroundUsed > 0) {
      const count =
        backgroundLimit > 0
          ? `${backgroundUsed}/${backgroundLimit}`
          : String(backgroundUsed);
      segments.push(
        theme.fg("text", "bg: ") + progressColor(0, count, theme),
      );
      compact.push(theme.fg("text", `bg ${backgroundUsed}`));
    }

    if (segments.length === 0) return "";

    const icon = progressColor(0, "↳", theme);
    const fullLine = `${icon} ${segments.join(sep)}`;
    const compactLine = `${icon} ${compact.join(sep)}`;
    return fitFooterSegment(width, [fullLine, compactLine]);
  }

  function nonNegativeInteger(value: unknown): number | null {
    return typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0
      ? value
      : null;
  }

  function publicAgentLabel(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const label = sanitizeFooterText(value).trim().slice(0, 48);
    return label || undefined;
  }

  function parseFleetLabels(record: Record<string, unknown>): string[] {
    if (!Array.isArray(record.entries)) return [];
    return record.entries
      .slice(0, 16)
      .map((entry) =>
        entry && typeof entry === "object" && !Array.isArray(entry)
          ? publicAgentLabel((entry as Record<string, unknown>).agent)
          : undefined,
      )
      .filter((label): label is string => Boolean(label));
  }

  function parseAsyncAgentProgress(value: unknown): AsyncAgentProgress | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const snapshot = value as Record<string, unknown>;
    if (
      snapshot.kind !== "pi-subagents.async-status-snapshot" ||
      snapshot.version !== 1 ||
      !Array.isArray(snapshot.runs)
    ) {
      return null;
    }

    let active = 0;
    let total = 0;
    let visited = 0;
    let hasActiveRun = false;
    const labels: string[] = [];
    const isActive = (state: unknown) => state === "queued" || state === "running";

    const collectLeaves = (node: unknown, depth: number): void => {
      if (
        visited >= 64 ||
        depth > 4 ||
        !node ||
        typeof node !== "object" ||
        Array.isArray(node)
      ) {
        return;
      }
      visited += 1;
      const record = node as Record<string, unknown>;
      const children = Array.isArray(record.children)
        ? record.children.slice(0, 8)
        : [];
      if (children.length > 0 && depth < 4) {
        for (const child of children) collectLeaves(child, depth + 1);
        return;
      }

      total += 1;
      if (!isActive(record.state)) return;
      active += 1;
      const label = publicAgentLabel(record.label);
      if (label) labels.push(label);
    };

    for (const run of snapshot.runs.slice(0, 20)) {
      if (
        !run ||
        typeof run !== "object" ||
        Array.isArray(run) ||
        !isActive((run as Record<string, unknown>).state)
      ) {
        continue;
      }
      hasActiveRun = true;
      collectLeaves(run, 0);
    }

    return hasActiveRun ? { active, total, labels } : null;
  }

  function parseFleetSummary(value: unknown): SubagentFleetSummary | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const data = value as Record<string, unknown>;
    const fleet = data.fleet;
    if (!fleet || typeof fleet !== "object" || Array.isArray(fleet)) return null;
    const record = fleet as Record<string, unknown>;
    if (record.version !== 1) return null;

    const fleetActive = nonNegativeInteger(record.totalActive);
    if (fleetActive === null) return null;
    const asyncProgress = parseAsyncAgentProgress(data.asyncSnapshot);
    const fleetLabels = parseFleetLabels(record);

    // Fleet Status v1 originally omitted capacity. Treat it as zero so older
    // pi-subagents releases still provide the active child count.
    const capacity = record.topLevelAsyncCapacity;
    if (capacity === undefined) {
      return {
        activeAgents: asyncProgress?.active ?? fleetActive,
        totalAgents: asyncProgress?.total ?? fleetActive,
        agentLabels: asyncProgress?.labels ?? fleetLabels,
        backgroundUsed: 0,
        backgroundLimit: 0,
      };
    }
    if (
      !capacity ||
      typeof capacity !== "object" ||
      Array.isArray(capacity)
    ) {
      return null;
    }

    const capacityRecord = capacity as Record<string, unknown>;
    const backgroundUsed = nonNegativeInteger(capacityRecord.used);
    const backgroundLimit = nonNegativeInteger(capacityRecord.limit);
    if (backgroundUsed === null || backgroundLimit === null) return null;

    return {
      activeAgents: asyncProgress?.active ?? fleetActive,
      totalAgents: asyncProgress?.total ?? fleetActive,
      agentLabels: asyncProgress?.labels ?? fleetLabels,
      backgroundUsed,
      backgroundLimit,
    };
  }

  function stopWorkTimers(): void {
    if (workRenderTimer) {
      clearInterval(workRenderTimer);
      workRenderTimer = null;
    }
    if (fleetRefreshTimer) {
      clearInterval(fleetRefreshTimer);
      fleetRefreshTimer = null;
    }
  }

  function syncWorkTimers(): void {
    if (!showWorkStatus || !sessionActive || !footerAttached) {
      stopWorkTimers();
      return;
    }

    const hasWork =
      activeMainTools().length > 0 ||
      (fleetSummary?.totalAgents ?? 0) > 0 ||
      (fleetSummary?.backgroundUsed ?? 0) > 0;

    if (hasWork && !workRenderTimer) {
      workRenderTimer = setInterval(() => tuiRef?.requestRender(), 1000);
      workRenderTimer.unref?.();
    } else if (!hasWork && workRenderTimer) {
      clearInterval(workRenderTimer);
      workRenderTimer = null;
    }

    const hasSubagentWork =
      subagentRpcAvailable &&
      ((fleetSummary?.totalAgents ?? 0) > 0 ||
        (fleetSummary?.backgroundUsed ?? 0) > 0);
    if (hasSubagentWork && !fleetRefreshTimer) {
      fleetRefreshTimer = setInterval(() => refreshFleetStatus(), 2000);
      fleetRefreshTimer.unref?.();
    } else if (!hasSubagentWork && fleetRefreshTimer) {
      clearInterval(fleetRefreshTimer);
      fleetRefreshTimer = null;
    }
  }

  function requestSubagentRpc(
    method: "ping" | "status",
    generation: number,
  ): Promise<unknown | null> {
    return new Promise((resolve) => {
      if (!sessionActive || generation !== sessionGeneration) {
        resolve(null);
        return;
      }

      const requestId = randomUUID();
      let settled = false;
      let unsubscribe: (() => void) | undefined;
      const finish = (value: unknown | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        unsubscribe?.();
        resolve(value);
      };
      const timeout = setTimeout(
        () => finish(null),
        SUBAGENT_RPC_TIMEOUT_MS,
      );
      timeout.unref?.();

      const maybeUnsubscribe = pi.events.on(
        `${SUBAGENT_RPC_REPLY_PREFIX}${requestId}`,
        (payload: unknown) => {
          const reply = payload as SubagentRpcReply;
          if (
            reply?.version !== 1 ||
            reply.requestId !== requestId ||
            reply.success !== true
          ) {
            finish(null);
            return;
          }
          finish(reply.data ?? null);
        },
      );
      if (typeof maybeUnsubscribe === "function") unsubscribe = maybeUnsubscribe;

      pi.events.emit(SUBAGENT_RPC_REQUEST_EVENT, {
        version: 1,
        requestId,
        method,
        params: {},
        source: { extension: "@mhjerryjin/pi-footer" },
      });
    });
  }

  async function probeSubagentRpc(generation = sessionGeneration): Promise<void> {
    if (!showWorkStatus || !sessionActive) return;
    const data = await requestSubagentRpc("ping", generation);
    if (!sessionActive || generation !== sessionGeneration) return;

    const record =
      data && typeof data === "object" && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : null;
    const capabilities = record?.capabilities;
    const fleetCapability =
      capabilities && typeof capabilities === "object"
        ? (capabilities as Record<string, unknown>).fleetStatus
        : null;
    subagentRpcAvailable = Boolean(
      fleetCapability &&
        typeof fleetCapability === "object" &&
        (fleetCapability as Record<string, unknown>).version === 1,
    );

    if (subagentRpcAvailable) refreshFleetStatus(generation);
  }

  async function refreshFleetStatus(
    generation = sessionGeneration,
  ): Promise<void> {
    if (
      !showWorkStatus ||
      !sessionActive ||
      !subagentRpcAvailable ||
      fleetRequestInFlight
    ) {
      return;
    }

    fleetRequestInFlight = true;
    try {
      const data = await requestSubagentRpc("status", generation);
      if (!sessionActive || generation !== sessionGeneration) return;
      const next = parseFleetSummary(data);
      if (next) {
        fleetSummary = next;
        fleetUpdatedAt = Date.now();
        fleetConsecutiveFailures = 0;
      } else {
        fleetConsecutiveFailures += 1;
        if (
          fleetSummary &&
          Date.now() - fleetUpdatedAt >= FLEET_STALE_AFTER_MS
        ) {
          fleetSummary = null;
          fleetUpdatedAt = 0;
        }
        if (fleetConsecutiveFailures <= MAX_FLEET_REFRESH_RETRIES) {
          scheduleFleetRefresh(fleetConsecutiveFailures * 500);
        }
      }
    } finally {
      fleetRequestInFlight = false;
      if (sessionActive && generation === sessionGeneration) {
        syncWorkTimers();
        tuiRef?.requestRender();
      }
    }
  }

  function scheduleFleetRefresh(delay = 0): void {
    if (!showWorkStatus || !sessionActive || !subagentRpcAvailable) return;
    const generation = sessionGeneration;
    const timer = setTimeout(() => refreshFleetStatus(generation), delay);
    timer.unref?.();
  }

  function resetWorkStatus(): void {
    activeTools.clear();
    fleetSummary = null;
    fleetUpdatedAt = 0;
    fleetConsecutiveFailures = 0;
    fleetRequestInFlight = false;
    stopWorkTimers();
    tuiRef?.requestRender();
  }

  function scheduleTerminalTitle(
    ctx: any,
    sessionName: string | undefined,
  ): void {
    if (!setTerminalTitle || !ctx.hasUI) return;
    if (terminalTitleTimer) clearTimeout(terminalTitleTimer);
    const generation = sessionGeneration;
    terminalTitleTimer = setTimeout(() => {
      terminalTitleTimer = null;
      if (!sessionActive || generation !== sessionGeneration) return;
      ctx.ui.setTitle(buildTerminalTitle(sessionName, ctx.cwd));
    }, 0);
    terminalTitleTimer.unref?.();
  }

  function refreshGitFooter(): void {
    if (refreshGitCache()) tuiRef?.requestRender();
  }

  /** Fetch usage for the active provider. Shows cached data immediately,
   *  then fetches fresh in the background. Discards results if provider
   *  changed while the fetch was in flight. */
  function fetchUsage(modelProvider: string): void {
    const provider = detectProvider(modelProvider);
    if (!provider) {
      activeProvider = null;
      latestUsage = null;
      stopRefreshTimer();
      tuiRef?.requestRender();
      return;
    }

    activeProvider = provider;

    // Show cached data immediately if available
    const cached = usageCache.get(provider);
    if (cached && cached.windows.length > 0) {
      latestUsage = cached;
    } else {
      // Never carry another provider's quota into the new selection while its
      // first request is still in flight.
      latestUsage = null;
    }
    tuiRef?.requestRender();

    // Fetch fresh in background — keep cached data on transient errors
    fetchUsageForProvider(provider)
      .then((u) => {
        if (!u || activeProvider !== provider) return;
        if (u.windows.length === 0 && u.error && cached?.windows.length) return;
        usageCache.set(provider, u);
        latestUsage = u;
        tuiRef?.requestRender();
      })
      .catch(() => {});
  }

  /** Start (or restart) the periodic refresh timer. */
  function startRefreshTimer(): void {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      if (activeProvider) {
        const provider = activeProvider;
        const cached = usageCache.get(provider);
        fetchUsageForProvider(provider)
          .then((u) => {
            if (!u || activeProvider !== provider) return;
            if (u.windows.length === 0 && u.error && cached?.windows.length)
              return;
            usageCache.set(provider, u);
            latestUsage = u;
            tuiRef?.requestRender();
          })
          .catch(() => {});
      }
    }, USAGE_REFRESH_INTERVAL);
  }

  function stopRefreshTimer(): void {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  const loadServiceTierDefaults = (): unknown => {
    const configPath = join(homedir(), ".pi", "agent", "service-tier.json");
    try {
      return existsSync(configPath)
        ? JSON.parse(readFileSync(configPath, "utf8"))
        : {};
    } catch {
      return {};
    }
  };

  const refreshFastMode = (ctx: any): void => {
    const branch = ctx.sessionManager.getBranch?.() ?? [];
    const nextFastMode = resolveFastServiceTierState(
      ctx.model,
      loadServiceTierDefaults(),
      branch,
    );
    if (fastModeActive === nextFastMode) return;
    fastModeActive = nextFastMode;
    tuiRef?.requestRender();
  };

  const eventDisposers = [
    pi.events.on("pi-fancy-footer:widget", (message) => {
      const record = recordValue(message);
      const widget = recordValue(record?.widget);
      const isServiceTierUpdate =
        record?.protocol === 1 &&
        ((record.type === "upsert" &&
          widget?.id === "pi-service-tier.service-tier") ||
          (record.type === "remove" &&
            record.id === "pi-service-tier.service-tier"));
      if (isServiceTierUpdate && activeContext) refreshFastMode(activeContext);
    }),
    pi.events.on(SUBAGENT_RPC_READY_EVENT, () => {
      if (sessionActive) probeSubagentRpc();
    }),
    pi.events.on(SUBAGENT_ASYNC_STARTED_EVENT, () => scheduleFleetRefresh()),
    pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, () => scheduleFleetRefresh()),
  ].filter((dispose): dispose is () => void => typeof dispose === "function");

  pi.on("tool_execution_start", (event) => {
    if (!showWorkStatus || !sessionActive) return;
    activeTools.set(event.toolCallId, {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      startedAt: Date.now(),
    });
    syncWorkTimers();
    tuiRef?.requestRender();
    if (SUBAGENT_TOOL_NAMES.has(event.toolName)) scheduleFleetRefresh(100);
  });

  pi.on("tool_execution_update", (event) => {
    if (SUBAGENT_TOOL_NAMES.has(event.toolName)) scheduleFleetRefresh();
  });

  pi.on("tool_execution_end", (event) => {
    if (!showWorkStatus) return;
    activeTools.delete(event.toolCallId);
    syncWorkTimers();
    tuiRef?.requestRender();
    if (SUBAGENT_TOOL_NAMES.has(event.toolName)) scheduleFleetRefresh();
  });

  pi.on("session_start", async (_event, ctx) => {
    refreshGitCache();
    sessionGeneration += 1;
    sessionActive = true;
    activeContext = ctx;
    subagentRpcAvailable = false;
    refreshFastMode(ctx);
    resetWorkStatus();

    if (!ctx.hasUI) return;

    // Pi restores its built-in `π - session - project` title after extension
    // session_start handlers finish. Defer ours by one event-loop turn so the
    // user-selected format remains authoritative.
    scheduleTerminalTitle(ctx, pi.getSessionName());

    ctx.ui.setFooter((tui: any, theme: any, footerData: any) => {
      tuiRef = tui;
      footerAttached = true;

      const unsub = footerData.onBranchChange(() => {
        refreshGitFooter();
      });

      // Initial fetch inside factory — tui is guaranteed available here,
      // so requestRender() will work when the async fetch completes.
      if (ctx.model?.provider) {
        fetchUsage(ctx.model.provider);
        startRefreshTimer();
      }

      return {
        dispose: () => {
          unsub();
          footerAttached = false;
          tuiRef = null;
          stopRefreshTimer();
          stopWorkTimers();
        },
        invalidate() {},
        render(width: number): string[] {
          const {
            thinkingLevel,
            percentage,
            used: ctxUsed,
            total: ctxTotal,
            estimated: contextEstimated,
          } = getSessionFooterState(ctx);

          // Build parts for status line
          const home = process.env.HOME || process.env.USERPROFILE;
          const pwd = abbreviateHomePath(ctx.cwd, home);

          let branchStr = "";
          if (showBranch && gitCache?.branch) {
            branchStr = theme.fg("text", "git: ");
            branchStr += headerColor("git", gitCache.branch, theme);
            if (gitCache.dirty) branchStr += headerColor("git", "*", theme);
            if (gitCache.ahead)
              branchStr += headerColor("git", ` +${gitCache.ahead}`, theme);
            if (gitCache.behind)
              branchStr += headerColor("git", ` -${gitCache.behind}`, theme);
          }

          // Model + thinking
          const modelName = ctx.model?.id?.split("/").pop() || "no-model";
          const statusIcon = progressColor(0, "●", theme);
          const modelBlock =
            `${statusIcon} ` +
            theme.fg("text", "model: ") +
            headerColor("model", modelName, theme);
          const effortValue = fastModeActive
            ? `${thinkingLevel} fast`
            : thinkingLevel;
          const effortBlock =
            theme.fg("text", "effort: ") +
            headerColor("thinking", effortValue, theme);

          const sep = theme.fg("text", " │ ");

          const sessionName = showSessionName ? pi.getSessionName() : undefined;
          const sessionBlock = sessionName
            ? fitFooterSegment(width, [
                theme.fg("text", "session: ") +
                  headerColor("session", sessionName, theme),
                headerColor("session", sessionName, theme),
              ])
            : "";

          const pwdStr = showCwd
            ? theme.fg("text", "dir: ") + headerColor("dir", pwd, theme)
            : "";
          const contextBlock = fitFooterSegment(width, [
            renderContextGauge(percentage, theme, ctxUsed, ctxTotal, {
              barWidth: CTX_GAUGE_WIDTH,
              includeCounts: true,
              estimated: contextEstimated,
            }),
            renderContextGauge(percentage, theme, ctxUsed, ctxTotal, {
              barWidth: 8,
              includeCounts: false,
              estimated: contextEstimated,
            }),
            renderContextGauge(percentage, theme, ctxUsed, ctxTotal, {
              barWidth: 6,
              includeCounts: false,
              estimated: contextEstimated,
            }),
            renderContextGauge(percentage, theme, ctxUsed, ctxTotal, {
              barWidth: 4,
              includeCounts: false,
              estimated: contextEstimated,
            }),
          ]);
          const providerUsage = latestUsage
            ? renderProviderUsage(latestUsage, theme)
            : "";

          const firstLine = [
            modelBlock,
            effortBlock,
            pwdStr,
            branchStr,
            sessionBlock,
          ]
            .filter(Boolean)
            .join(sep);
          const contextIcon = progressColor(percentage, "◐", theme);
          const secondLine = [`${contextIcon} ${contextBlock}`, providerUsage]
            .filter(Boolean)
            .join(sep);

          const lines = [
            truncateToWidth(`${NORMAL_INTENSITY} ${firstLine}`, width),
            truncateToWidth(`${NORMAL_INTENSITY} ${secondLine}`, width),
          ];
          if (showWorkStatus) {
            const workStatus =
              width > 1 ? renderWorkStatus(width - 1, theme) : "";
            lines.push(
              workStatus
                ? truncateToWidth(`${NORMAL_INTENSITY} ${workStatus}`, width)
                : "",
            );
          }
          return lines;
        },
      };
    });

    probeSubagentRpc(sessionGeneration);
  });

  pi.on("session_shutdown", () => {
    sessionGeneration += 1;
    sessionActive = false;
    activeContext = null;
    fastModeActive = false;
    if (terminalTitleTimer) {
      clearTimeout(terminalTitleTimer);
      terminalTitleTimer = null;
    }
    resetWorkStatus();
    for (const dispose of eventDisposers.splice(0)) dispose();
  });

  pi.on("turn_end", async () => {
    refreshGitFooter();
  });

  pi.on("session_compact", () => {
    tuiRef?.requestRender();
  });

  pi.on("session_info_changed", (event, ctx) => {
    scheduleTerminalTitle(ctx, event.name);
    tuiRef?.requestRender();
  });

  pi.on("session_tree", (_event, ctx) => {
    activeContext = ctx;
    refreshFastMode(ctx);
  });

  pi.on("before_provider_request", (event) => {
    if (!isFastServiceTierPayload(event.payload) || fastModeActive) return;
    fastModeActive = true;
    tuiRef?.requestRender();
  });

  // Refresh when model changes — fetch immediately, restart timer
  pi.on("model_select", (event, ctx) => {
    activeContext = ctx;
    refreshFastMode(ctx);
    if (!event.model?.provider) return;
    fetchUsage(event.model.provider);
    startRefreshTimer(); // reset the 5min countdown since we just fetched
  });
}
