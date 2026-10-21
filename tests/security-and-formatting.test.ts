import assert from "node:assert/strict";
import test from "node:test";
import {
  abbreviateHomePath,
  buildTerminalTitle,
  isFastServiceTierPayload,
  resolveCommandCodeCredential,
  resolveFastServiceTierState,
  resolveCodexSpeedLabel,
  sanitizeFooterText,
} from "../index.ts";

test("CommandCode accepts a generic apiKey only from its provider-specific file", () => {
  assert.equal(
    resolveCommandCodeCredential({ apiKey: " commandcode-secret " }, true),
    "commandcode-secret",
  );
  assert.equal(
    resolveCommandCodeCredential({ apiKey: "unrelated-secret" }, false),
    undefined,
  );
});

test("CommandCode resolves supported provider-scoped shared auth shapes", () => {
  assert.equal(
    resolveCommandCodeCredential({ commandcode: "direct-secret" }),
    "direct-secret",
  );
  assert.equal(
    resolveCommandCodeCredential({
      commandcode: { type: "oauth", access: "oauth-secret" },
    }),
    "oauth-secret",
  );
  assert.equal(
    resolveCommandCodeCredential({
      "command-code": { type: "api", key: "official-secret" },
    }),
    "official-secret",
  );
});

test("CommandCode rejects malformed and unrelated auth values", () => {
  assert.equal(resolveCommandCodeCredential(null, true), undefined);
  assert.equal(resolveCommandCodeCredential([], true), undefined);
  assert.equal(resolveCommandCodeCredential({ anthropic: "secret" }, true), undefined);
  assert.equal(resolveCommandCodeCredential({ commandcode: "   " }), undefined);
});

test("footer text strips terminal controls and bidi overrides", () => {
  assert.equal(
    sanitizeFooterText("safe\u001b[31m\nname\u202E"),
    "safe[31mname",
  );
});

test("terminal title prefers a sanitized session name and falls back to project", () => {
  assert.equal(
    buildTerminalTitle(" footer-work ", "/Users/jerry/pi-footer"),
    "pi · footer-work",
  );
  assert.equal(
    buildTerminalTitle(undefined, "/Users/jerry/pi-footer"),
    "pi · pi-footer",
  );
  assert.equal(
    buildTerminalTitle("bad\u001b]2;title\u0007", "/tmp/project"),
    "pi · bad]2;title",
  );
});

test("fast mode requires an explicit fast or priority service tier", () => {
  assert.equal(isFastServiceTierPayload({ service_tier: "fast" }), true);
  assert.equal(isFastServiceTierPayload({ service_tier: "priority" }), true);
  assert.equal(isFastServiceTierPayload({ serviceTier: " FAST " }), true);
  assert.equal(isFastServiceTierPayload({ service_tier: "default" }), false);
  assert.equal(isFastServiceTierPayload({}), false);
  assert.equal(isFastServiceTierPayload(null), false);
});

test("fast mode resolves pi-service-tier defaults and session overrides", () => {
  const model = {
    provider: "openai-codex",
    api: "openai-codex-responses",
  };
  assert.equal(
    resolveFastServiceTierState(model, { "openai-codex": "priority" }, []),
    true,
  );
  assert.equal(
    resolveFastServiceTierState(
      model,
      { "openai-codex": "priority" },
      [
        {
          type: "custom",
          customType: "pi-service-tier",
          data: { version: 1, overrides: { "openai-codex": "" } },
        },
      ],
    ),
    false,
  );
  assert.equal(
    resolveFastServiceTierState(
      { ...model, api: "openai-responses" },
      { "openai-codex": "priority" },
      [],
    ),
    false,
  );
});

test("Codex speed labels follow runtime status and supported models", () => {
  const model = { provider: "openai-codex", id: "gpt-6.1-sol" };
  assert.equal(resolveCodexSpeedLabel(model, "\u001b[36mUltrafast\u001b[39m"), "ultrafast");
  assert.equal(resolveCodexSpeedLabel(model, "Fast"), "fast");
  assert.equal(resolveCodexSpeedLabel(model, undefined), "");
  assert.equal(resolveCodexSpeedLabel(model, "off"), "");
  assert.equal(resolveCodexSpeedLabel({ ...model, id: "gpt-5.6-sol" }, "Ultrafast"), "");
  assert.equal(resolveCodexSpeedLabel({ provider: "openai", id: "gpt-5.6-sol" }, "Ultrafast"), "ultrafast");
  assert.equal(resolveCodexSpeedLabel({ ...model, provider: "ollama" }, "Fast"), "");
});

test("home abbreviation requires a path boundary", () => {
  assert.equal(abbreviateHomePath("/Users/jerry/project", "/Users/jerry"), "~/project");
  assert.equal(abbreviateHomePath("/Users/jerry", "/Users/jerry"), "~");
  assert.equal(
    abbreviateHomePath("/Users/jerry-other/project", "/Users/jerry"),
    "/Users/jerry-other/project",
  );
  assert.equal(
    abbreviateHomePath("C:\\Users\\Jerry\\Project", "c:\\users\\jerry", "win32"),
    "~\\Project",
  );
});
