import _sodium from 'libsodium-wrappers';

let ready = false;

async function sodium() {
  if (!ready) {
    await _sodium.ready;
    ready = true;
  }
  return _sodium;
}

function getKey(): Uint8Array {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw) throw new Error('TOKEN_ENCRYPTION_KEY is not set');
  const bytes = Buffer.from(raw, 'base64');
  if (bytes.length !== 32)
    throw new Error(`TOKEN_ENCRYPTION_KEY must be 32 bytes (got ${bytes.length})`);
  return new Uint8Array(bytes);
}

export async function encryptToken(plaintext: string): Promise<string> {
  const lib = await sodium();
  const key = getKey();
  const nonce = lib.randombytes_buf(lib.crypto_secretbox_NONCEBYTES);
  const ciphertext = lib.crypto_secretbox_easy(new TextEncoder().encode(plaintext), nonce, key);
  // Store as base64(nonce + ciphertext)
  const combined = new Uint8Array(nonce.length + ciphertext.length);
  combined.set(nonce, 0);
  combined.set(ciphertext, nonce.length);
  return Buffer.from(combined).toString('base64');
}

export async function decryptToken(ciphertext: string): Promise<string> {
  const lib = await sodium();
  const key = getKey();
  const combined = new Uint8Array(Buffer.from(ciphertext, 'base64'));
  const nonceLen = lib.crypto_secretbox_NONCEBYTES;
  if (combined.length <= nonceLen) throw new Error('Invalid ciphertext: too short');
  const nonce = combined.slice(0, nonceLen);
  const box = combined.slice(nonceLen);
  const plaintext = lib.crypto_secretbox_open_easy(box, nonce, key);
  if (!plaintext) throw new Error('Decryption failed: invalid or tampered ciphertext');
  return new TextDecoder().decode(plaintext);
}
