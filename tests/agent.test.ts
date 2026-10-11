import { test } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { runAgent, friendlyErrorMessage, type AgentEvent, type ToolDef } from "../src/agent.ts";

// A fake Anthropic client: each scripted turn is a list of content blocks the model "returns".
function fakeClient(turns: Array<{ content: any[]; stop_reason: string }>) {
  let i = 0;
  const seen: any[] = [];
  return {
    seen,
    messages: {
      stream(params: any) {
        seen.push(params);
        const turn = turns[Math.min(i++, turns.length - 1)];
        const events = turn.content.flatMap((b) =>
          b.type === "text"
            ? [{ type: "content_block_delta", delta: { type: "text_delta", text: b.text } }]
            : b.type === "thinking"
              ? [{ type: "content_block_delta", delta: { type: "thinking_delta", thinking: b.thinking } }]
              : [],
        );
        return {
          async *[Symbol.asyncIterator]() {
            for (const e of events) yield e;
          },
          async finalMessage() {
            return { content: turn.content, stop_reason: turn.stop_reason, usage: { input_tokens: 10, output_tokens: 5 } };
          },
        };
      },
    },
  } as any;
}

async function collect(gen: AsyncGenerator<AgentEvent>) {
  const out: AgentEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

const echoTool: ToolDef = {
  name: "echo",
  description: "echoes",
  input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
  run: async (input) => ({ results: [input.text], summary: `echoed ${input.text}` }),
};
const boomTool: ToolDef = {
  name: "boom",
  description: "fails",
  input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  run: async () => {
    throw new Error("kaboom");
  },
};

test("runs tools, feeds results back, and finishes with the final text", async () => {
  const client = fakeClient([
    { content: [{ type: "text", text: "Let me check." }, { type: "tool_use", id: "t1", name: "echo", input: { text: "hi" } }, { type: "tool_use", id: "t2", name: "boom", input: {} }], stop_reason: "tool_use" },
    { content: [{ type: "text", text: "All done." }], stop_reason: "end_turn" },
  ]);
  const events = await collect(runAgent({ client, model: "m", system: "s", messages: [{ role: "user", content: "go" }], tools: [echoTool, boomTool] }));
  const types = events.map((e) => e.type);
  assert.deepEqual(types.slice(0, 2), ["turn", "text"]);
  assert.ok(types.includes("tool_call"));
  const results = events.filter((e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result");
  assert.equal(results.length, 2);
  assert.equal(results.find((r) => r.name === "echo")?.ok, true);
  assert.equal(results.find((r) => r.name === "echo")?.summary, "echoed hi");
  assert.equal(results.find((r) => r.name === "boom")?.ok, false);
  const done = events.at(-1) as Extract<AgentEvent, { type: "done" }>;
  assert.equal(done.type, "done");
  assert.equal(done.text, "All done.");
  assert.equal(done.turns, 2);
  assert.deepEqual(done.usage, { input: 20, output: 10 });

  // Second request carries the assistant turn and ONE user message holding both tool results.
  const second = client.seen[1].messages;
  assert.equal(second.length, 3);
  assert.equal(second[1].role, "assistant");
  assert.equal(second[2].role, "user");
  assert.equal(second[2].content.length, 2);
  assert.equal(second[2].content[1].is_error, true);
  // Tools are sent with strict schemas.
  assert.equal(client.seen[0].tools[0].strict, true);
});

test("unknown tool returns an error result instead of crashing", async () => {
  const client = fakeClient([
    { content: [{ type: "tool_use", id: "t1", name: "nope", input: {} }], stop_reason: "tool_use" },
    { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" },
  ]);
  const events = await collect(runAgent({ client, model: "m", system: "s", messages: [{ role: "user", content: "go" }], tools: [echoTool] }));
  const r = events.find((e) => e.type === "tool_result") as any;
  assert.equal(r.ok, false);
  assert.equal(events.at(-1)?.type, "done");
});

test("stops with an error when the turn cap is hit", async () => {
  const client = fakeClient([{ content: [{ type: "tool_use", id: "t", name: "echo", input: { text: "x" } }], stop_reason: "tool_use" }]);
  const events = await collect(runAgent({ client, model: "m", system: "s", messages: [{ role: "user", content: "go" }], tools: [echoTool], maxTurns: 2 }));
  assert.equal(events.filter((e) => e.type === "turn").length, 2);
  assert.equal(events.at(-1)?.type, "error");
});

test("refusal ends the loop without running tools", async () => {
  let ran = false;
  const spy: ToolDef = { ...echoTool, run: async () => ((ran = true), "x") };
  const client = fakeClient([{ content: [{ type: "tool_use", id: "t", name: "echo", input: { text: "x" } }], stop_reason: "refusal" }]);
  const events = await collect(runAgent({ client, model: "m", system: "s", messages: [{ role: "user", content: "go" }], tools: [spy] }));
  assert.equal(ran, false);
  assert.equal(events.at(-1)?.type, "error");
});

// ---- error sanitization ----

function failingClient(err: unknown) {
  return {
    messages: {
      stream() {
        return {
          async *[Symbol.asyncIterator]() {
            throw err;
          },
          async finalMessage() {
            throw err;
          },
        };
      },
    },
  } as any;
}

test("an Anthropic API error becomes a plain error event naming only the HTTP status", async () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    const raw = new Anthropic.APIError(529, { type: "overloaded_error" }, "Overloaded req_abc123 (model m, key sk-ant-xyz)", undefined);
    const events = await collect(runAgent({ client: failingClient(raw), model: "m", system: "s", messages: [{ role: "user", content: "go" }], tools: [echoTool] }));
    assert.deepEqual(events, [
      { type: "turn", n: 1 },
      { type: "error", message: "Claude is unavailable right now (HTTP 529). The Hollow Pines sample still works." },
    ]);

    const plain = await collect(runAgent({ client: failingClient(new Error("socket hang up at 10.0.0.5")), model: "m", system: "s", messages: [{ role: "user", content: "go" }], tools: [echoTool] }));
    assert.deepEqual(plain.at(-1), { type: "error", message: "Something went wrong on the server." });
  } finally {
    console.error = quiet;
  }
});

test("a request cancelled by the caller ends quietly, with no error event", async () => {
  const controller = new AbortController();
  const client = {
    messages: {
      stream() {
        return {
          async *[Symbol.asyncIterator]() {
            controller.abort();
            throw Object.assign(new Error("aborted"), { name: "AbortError" });
          },
          async finalMessage() {
            throw new Error("unreachable");
          },
        };
      },
    },
  } as any;
  const events = await collect(runAgent({ client, model: "m", system: "s", messages: [{ role: "user", content: "go" }], tools: [echoTool], signal: controller.signal }));
  assert.deepEqual(events, [{ type: "turn", n: 1 }]);
});

test("friendlyErrorMessage never echoes the original text", () => {
  assert.equal(friendlyErrorMessage(Object.assign(new Error("secret"), { status: 401 })), "Claude is unavailable right now (HTTP 401). The Hollow Pines sample still works.");
  assert.equal(friendlyErrorMessage(new Anthropic.APIError(undefined, undefined, "Connection error.", undefined)), "Claude is unavailable right now. The Hollow Pines sample still works.");
  assert.equal(friendlyErrorMessage(new Error("secret")), "Something went wrong on the server.");
  assert.equal(friendlyErrorMessage("secret"), "Something went wrong on the server.");
});
