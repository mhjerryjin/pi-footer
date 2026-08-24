import assert from "node:assert/strict";
import test from "node:test";
import {
  abbreviateHomePath,
  resolveCommandCodeCredential,
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
