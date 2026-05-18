import Anthropic from "@anthropic-ai/sdk";

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

export function anthropicClient(): Anthropic {
  return getClient();
}

export async function pingAnthropic(): Promise<{ latency_ms: number }> {
  const start = Date.now();
  await getClient().messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1,
    messages: [{ role: "user", content: "ping" }],
  });
  return { latency_ms: Date.now() - start };
}
