const OPENAI_TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions';
const TRANSCRIBE_MODEL = 'gpt-4o-mini-transcribe';

// Transcribes a Telegram voice note (OGG/OPUS) to text via OpenAI's audio API.
// Telegram voice notes are OGG/OPUS, which the endpoint accepts directly — no
// transcoding. Throws on a missing key or a non-2xx response so callers can
// surface a friendly fallback.
export async function transcribeOgg(audio: ArrayBuffer): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set');
  }

  const form = new FormData();
  form.append('file', new Blob([audio], { type: 'audio/ogg' }), 'voice.ogg');
  form.append('model', TRANSCRIBE_MODEL);
  form.append('response_format', 'text');

  const res = await fetch(OPENAI_TRANSCRIBE_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`OpenAI transcription failed (${res.status}): ${detail}`);
  }

  // response_format=text returns the raw transcript as the body.
  return (await res.text()).trim();
}
