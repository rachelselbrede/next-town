// A streaming tool-use agent loop on the Claude Messages API. Framework-free on purpose:
// the loop is small enough to read, and every tool call and result is surfaced as an event
// so the UI can show judges exactly what the agent did with Qloo.

import Anthropic from "@anthropic-ai/sdk";

export interface ToolDef<I = any> {
  name: string;
  description: string;
  input_schema: Record<string, unknown>; // JSON Schema object, additionalProperties: false
  run: (input: I, ctx: ToolContext) => Promise<unknown>;
}

export interface ToolContext {
  emit: (e: AgentEvent) => void;
  signal?: AbortSignal;
}

export type AgentEvent =
  | { type: "turn"; n: number }
  | { type: "thinking"; text: string }
  | { type: "text"; delta: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; ok: boolean; ms: number; summary: string; data?: unknown }
  | { type: "status"; message: string }
  | { type: "done"; text: string; turns: number; usage: { input: number; output: number } }
  | { type: "error"; message: string };

export interface RunAgentOptions {
  client: Anthropic;
  model: string;
  system: string;
  messages: Anthropic.MessageParam[];
  tools: ToolDef[];
  maxTurns?: number;
  maxTokens?: number;
  effort?: "low" | "medium" | "high";
  signal?: AbortSignal;
}

const MAX_RESULT_CHARS = 24_000;

function toApiTools(tools: ToolDef[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as Anthropic.Tool["input_schema"],
    strict: true,
  }));
}

function summarizeResult(result: unknown): string {
  if (typeof result === "string") return result.slice(0, 160);
  if (result && typeof result === "object") {
    const r = result as Record<string, any>;
    if (typeof r.summary === "string") return r.summary.slice(0, 160);
    if (typeof r.error === "string") return `error: ${r.error.slice(0, 140)}`;
    if (Array.isArray(r.results)) return `${r.results.length} results`;
  }
  return "ok";
}

export async function* runAgent(opts: RunAgentOptions): AsyncGenerator<AgentEvent> {
  const { client, model, system, tools, signal } = opts;
  const messages: Anthropic.MessageParam[] = [...opts.messages];
  const apiTools = toApiTools(tools);
  const byName = new Map(tools.map((t) => [t.name, t]));
  const maxTurns = opts.maxTurns ?? 12;
  const usage = { input: 0, output: 0 };
  let finalText = "";

  // Events raised inside tool handlers are queued and flushed between stream events.
  const queue: AgentEvent[] = [];
  const ctx: ToolContext = { emit: (e) => queue.push(e), signal };

  for (let turn = 1; turn <= maxTurns; turn++) {
    yield { type: "turn", n: turn };
    const stream = client.messages.stream(
      {
        model,
        max_tokens: opts.maxTokens ?? 8000,
        system,
        messages,
        tools: apiTools,
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: opts.effort ?? "medium" },
      },
      { signal },
    );

    let textThisTurn = "";
    for await (const event of stream) {
      if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") {
          textThisTurn += event.delta.text;
          yield { type: "text", delta: event.delta.text };
        } else if (event.delta.type === "thinking_delta" && event.delta.thinking) {
          yield { type: "thinking", text: event.delta.thinking };
        }
      }
    }

    const message = await stream.finalMessage();
    usage.input += message.usage.input_tokens;
    usage.output += message.usage.output_tokens;

    const toolUses = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");

    if (message.stop_reason === "refusal") {
      yield { type: "error", message: "The model declined this request." };
      break;
    }
    if (message.stop_reason === "max_tokens" && toolUses.length) {
      yield { type: "error", message: "Tool input was cut off (max_tokens). Try a shorter request." };
      break;
    }
    if (message.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: message.content });
      continue;
    }
    if (toolUses.length === 0) {
      finalText = textThisTurn;
      yield { type: "done", text: finalText, turns: turn, usage };
      return;
    }

    messages.push({ role: "assistant", content: message.content });

    // Run every tool call from this turn concurrently, then answer with ALL results in one user message.
    const results = await Promise.all(
      toolUses.map(async (tu): Promise<{ block: Anthropic.ToolResultBlockParam; event: AgentEvent }> => {
        const tool = byName.get(tu.name);
        const t0 = Date.now();
        queue.push({ type: "tool_call", id: tu.id, name: tu.name, input: tu.input });
        if (!tool) {
          return {
            block: { type: "tool_result", tool_use_id: tu.id, is_error: true, content: `Unknown tool ${tu.name}` },
            event: { type: "tool_result", id: tu.id, name: tu.name, ok: false, ms: 0, summary: "unknown tool" },
          };
        }
        try {
          const result = await tool.run(tu.input, ctx);
          let content = typeof result === "string" ? result : JSON.stringify(result);
          if (content.length > MAX_RESULT_CHARS) content = content.slice(0, MAX_RESULT_CHARS) + "\n…[truncated]";
          return {
            block: { type: "tool_result", tool_use_id: tu.id, content },
            event: { type: "tool_result", id: tu.id, name: tu.name, ok: true, ms: Date.now() - t0, summary: summarizeResult(result), data: result },
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            block: { type: "tool_result", tool_use_id: tu.id, is_error: true, content: msg },
            event: { type: "tool_result", id: tu.id, name: tu.name, ok: false, ms: Date.now() - t0, summary: `error: ${msg.slice(0, 140)}` },
          };
        }
      }),
    );

    while (queue.length) yield queue.shift()!;
    for (const r of results) yield r.event;
    messages.push({ role: "user", content: results.map((r) => r.block) });
  }

  if (!finalText) {
    yield { type: "error", message: `Stopped after ${maxTurns} turns without a final answer.` };
  }
}
