import assert from "node:assert/strict";
import test from "node:test";
import footerExtension from "../index.ts";

type Handler = (event: any, context?: any) => unknown;

function createHarness(options: { rpc?: boolean } = {}) {
  const hooks = new Map<string, Handler[]>();
  const bus = new Map<string, Handler[]>();
  let footerFactory: any;
  const titles: string[] = [];
  let asyncSnapshot: any;
  let fleet: any = {
    version: 1,
    entries: [],
    totalActive: 0,
    topLevelAsyncCapacity: { used: 0, limit: 4 },
    omitted: 0,
  };

  const events = {
    on(name: string, handler: Handler) {
      const handlers = bus.get(name) ?? [];
      handlers.push(handler);
      bus.set(name, handlers);
      return () => {
        bus.set(
          name,
          (bus.get(name) ?? []).filter((candidate) => candidate !== handler),
        );
      };
    },
    emit(name: string, data: any) {
      if (options.rpc !== false && name === "subagents:rpc:v1:request") {
        const response =
          data.method === "ping"
            ? { capabilities: { fleetStatus: { version: 1 } } }
            : { fleet, ...(asyncSnapshot ? { asyncSnapshot } : {}) };
        queueMicrotask(() => {
          events.emit(`subagents:rpc:v1:reply:${data.requestId}`, {
            version: 1,
            requestId: data.requestId,
            success: true,
            data: response,
          });
        });
        return;
      }
      for (const handler of bus.get(name) ?? []) handler(data);
    },
  };

  const pi = {
    on(name: string, handler: Handler) {
      const handlers = hooks.get(name) ?? [];
      handlers.push(handler);
      hooks.set(name, handlers);
    },
    events,
    getSessionName: () => undefined,
  };
  footerExtension(pi as any);

  const context = {
    hasUI: true,
    cwd: "/tmp/project",
    model: undefined,
    sessionManager: {
      getEntries: () => [],
      getLeafId: () => null,
      getSessionId: () => "session-1",
      getSessionFile: () => null,
    },
    ui: {
      setFooter(factory: any) {
        footerFactory = factory;
      },
      setTitle(title: string) {
        titles.push(title);
      },
    },
  };

  const emitHook = async (name: string, event: any) => {
    for (const handler of hooks.get(name) ?? []) await handler(event, context);
  };

  return {
    context,
    events,
    emitHook,
    titles,
    setFleet(value: any) {
      fleet = value;
    },
    setAsyncSnapshot(value: any) {
      asyncSnapshot = value;
    },
    async start() {
      await emitHook("session_start", {});
      // Pi core restores its built-in title after extension session_start.
      titles.push("π - project");
      await new Promise((resolve) => setTimeout(resolve, 20));
      const footer = footerFactory(
        { requestRender() {} },
        {
          fg: (_name: string, text: string) => text,
          getColorMode: () => "truecolor",
        },
        { onBranchChange: () => () => {} },
      );
      const render = (width = 120) =>
        footer
          .render(width)
          .map((line: string) => line.replace(/\u001b\[[0-9;]*m/g, ""));
      return { footer, render };
    },
  };
}

test("work row stays reserved and summarizes tools plus Fleet counts", async () => {
  const harness = createHarness();
  const { footer, render } = await harness.start();

  assert.equal(harness.titles.at(-1), "pi · project");
  await harness.emitHook("session_info_changed", { name: "footer-work" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(harness.titles.at(-1), "pi · footer-work");
  assert.deepEqual(render().length, 3);
  assert.equal(render()[2], "");

  harness.setFleet({
    version: 1,
    entries: [{ agent: "reviewer" }, { agent: "reviewer" }],
    totalActive: 2,
    topLevelAsyncCapacity: { used: 1, limit: 4 },
    omitted: 0,
  });
  harness.setAsyncSnapshot({
    kind: "pi-subagents.async-status-snapshot",
    version: 1,
    generatedAt: Date.now(),
    caps: {},
    omitted: {},
    runs: [
      {
        id: "run-1",
        kind: "subagent",
        label: "reviewer ×2",
        state: "running",
        children: [
          { id: "step-1", kind: "step", label: "reviewer", state: "complete" },
          { id: "step-2", kind: "step", label: "reviewer", state: "running" },
        ],
      },
    ],
  });
  harness.events.emit("subagent:async-started", {});
  await new Promise((resolve) => setTimeout(resolve, 20));

  await harness.emitHook("tool_execution_start", {
    toolCallId: "tool-1",
    toolName: "bash",
    args: {},
  });
  const active = render();
  assert.match(active[2], /task: bash/);
  assert.match(active[2], /agents: 1\/2/);
  assert.match(active[2], /reviewer running/);
  assert.match(active[2], /bg: 1\/4/);
  assert.equal(render(1).length, 3);
  assert.ok(render(8).every((line: string) => line.length <= 8));

  await harness.emitHook("tool_execution_end", {
    toolCallId: "tool-1",
    toolName: "bash",
    result: {},
    isError: false,
  });
  await harness.emitHook("session_shutdown", {});
  footer.dispose();
});

test("capacity-less Fleet v1 remains compatible", async () => {
  const harness = createHarness();
  const { footer, render } = await harness.start();
  harness.setFleet({ version: 1, entries: [], totalActive: 3, omitted: 0 });
  harness.events.emit("subagent:async-complete", {});
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.match(render()[2], /agents: 3/);
  assert.doesNotMatch(render()[2], /bg:/);
  await harness.emitHook("session_shutdown", {});
  footer.dispose();
});

test("subagent tools fall back to task display when Fleet RPC is absent", async () => {
  const harness = createHarness({ rpc: false });
  const { footer, render } = await harness.start();
  await harness.emitHook("tool_execution_start", {
    toolCallId: "subagent-1",
    toolName: "subagent",
    args: {},
  });

  assert.match(render()[2], /task: subagent/);
  await harness.emitHook("tool_execution_end", {
    toolCallId: "subagent-1",
    toolName: "subagent",
    result: {},
    isError: false,
  });
  await harness.emitHook("session_shutdown", {});
  footer.dispose();
});
