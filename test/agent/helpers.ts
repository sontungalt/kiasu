import type { AgentTool } from "../../src/agent/tools.js";

/** Calls a tool the way the tool runner does: parse() validates the input with its Zod schema, then run(). */
export async function callTool(tools: AgentTool[], name: string, input: unknown): Promise<string> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool named ${name}`);
  return (await tool.run(tool.parse(input))) as string;
}

type ToolDefinition = { name: string; strict?: boolean; input_schema: { type: string; additionalProperties?: boolean } };

/** The fields the API receives for a tool (the runner strips run/parse). */
export function definitionOf(tool: AgentTool): ToolDefinition {
  return tool as unknown as ToolDefinition;
}
