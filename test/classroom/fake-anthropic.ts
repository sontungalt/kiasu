import Anthropic from "@anthropic-ai/sdk";

export type FakeReply = { text: string; stopReason?: string } | { httpStatus: number };

/** An Anthropic client whose fetch records each Messages API request body and answers with a canned reply. */
export function fakeAnthropic(handler: (body: Record<string, any>) => FakeReply) {
  const requests: Array<Record<string, any>> = [];
  const fetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, any>;
    requests.push(body);
    const reply = handler(body);
    const headers = { "content-type": "application/json" };
    if ("httpStatus" in reply) {
      return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: "fake failure" } }), {
        status: reply.httpStatus,
        headers,
      });
    }
    return new Response(
      JSON.stringify({
        id: "msg_fake",
        type: "message",
        role: "assistant",
        model: body.model,
        content: [{ type: "text", text: reply.text }],
        stop_reason: reply.stopReason ?? "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 10 },
      }),
      { status: 200, headers },
    );
  };
  return { client: new Anthropic({ apiKey: "x", fetch, maxRetries: 0 }), requests };
}

export const jsonReply = (value: unknown): FakeReply => ({ text: JSON.stringify(value) });
