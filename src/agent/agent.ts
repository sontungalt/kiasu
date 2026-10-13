import type Anthropic from "@anthropic-ai/sdk";
import type { ChatAgent, Deps } from "../ports.js";
import type { ConversationTurn } from "../types.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import { buildTools } from "./tools.js";
import { buildTurnContext } from "./context.js";

export type AgentDeps = Pick<Deps, "config" | "clock" | "log" | "store" | "anthropic" | "mail" | "calendar">;

export const HISTORY_TURNS = 20;
export const MAX_TOOL_ROUNDS = 8;
export const MAX_TOKENS = 16000;
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export const REFUSAL_TEXT = "Sorry, I couldn't help with that one.";
export const EMPTY_TEXT = "Hmm, I couldn't put a reply together. Could you say that again?";
export const TOO_MANY_STEPS_TEXT = "Sorry, that took too many steps. Could you ask in a simpler way?";

type Turn = Pick<ConversationTurn, "role" | "text">;

/**
 * Plain-text history for the API: drops empty and leading assistant turns, and merges
 * consecutive same-role turns so roles strictly alternate starting with "user".
 */
export function toAlternatingMessages(turns: Turn[]): Anthropic.Beta.BetaMessageParam[] {
  const out: { role: "user" | "assistant"; content: string }[] = [];
  for (const t of turns) {
    const text = t.text.trim();
    if (!text) continue;
    if (out.length === 0 && t.role === "assistant") continue;
    const last = out[out.length - 1];
    if (last && last.role === t.role) last.content = `${last.content}\n\n${text}`;
    else out.push({ role: t.role, content: text });
  }
  return out;
}

/** The text the user should see, from the tool runner's final message. */
export function finalReplyText(message: Anthropic.Beta.BetaMessage): string {
  if (message.stop_reason === "refusal") return REFUSAL_TEXT;
  // The runner stopped at max_iterations while the model still wanted tools.
  if (message.stop_reason === "tool_use") return TOO_MANY_STEPS_TEXT;
  const text = message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  return text || EMPTY_TEXT;
}

export function createChatAgent(deps: AgentDeps): ChatAgent {
  const tools = buildTools(deps);

  return {
    async reply(text: string): Promise<string> {
      const now = deps.clock.now();
      const [history, context] = await Promise.all([
        deps.store.conversation.recent(HISTORY_TURNS),
        buildTurnContext(deps, now),
      ]);
      const messages: Anthropic.Beta.BetaMessageParam[] = [
        ...toAlternatingMessages([...history, { role: "user", text }]),
        // Mid-conversation system message, LAST, after the user turn: volatile content stays
        // behind the cached prefix. Supported on claude-sonnet-5-5 without a beta header.
        { role: "system", content: context },
      ];

      const final = await deps.anthropic.beta.messages.toolRunner({
        model: deps.config.CHAT_MODEL,
        max_tokens: MAX_TOKENS,
        // Explicit breakpoint on the frozen prefix (tools + system) plus automatic caching for the tail.
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        cache_control: { type: "ephemeral" },
        thinking: { type: "adaptive" },
        output_config: { effort: "low" },
        betas: [FALLBACK_BETA],
        fallbacks: "default",
        tools,
        messages,
        // max_iterations counts API requests: MAX_TOOL_ROUNDS tool rounds plus the final answer.
        max_iterations: MAX_TOOL_ROUNDS + 1,
      });

      const replyText = finalReplyText(final);
      if (final.stop_reason !== "end_turn") {
        deps.log.warn("agent reply ended unusually", {
          stopReason: final.stop_reason,
          category: final.stop_details?.category ?? null,
        });
      }

      // Plain text only: thinking blocks are never stored or replayed across turns.
      const doneAt = new Date(Math.max(deps.clock.now().getTime(), now.getTime() + 1));
      await deps.store.conversation.append({ role: "user", text, at: now.toISOString() });
      await deps.store.conversation.append({ role: "assistant", text: replyText, at: doneAt.toISOString() });
      return replyText;
    },
  };
}
