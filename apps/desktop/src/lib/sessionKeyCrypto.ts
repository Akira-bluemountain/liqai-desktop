'use client';

/**
 * Symmetric encryption helpers for session-key persistence.
 *
 * SECURITY (docs/security-v2.md S5.2):
 *   - AES-GCM 256-bit, PBKDF2-SHA256 with 200k iterations (OWASP 2024
 *     recommendation for password-derived keys without a HSM).
 *   - Per-message random salt (16 bytes) and IV (12 bytes).
 *   - All randomness from crypto.getRandomValues (platform CSPRNG).
 *   - Plaintext is never logged. Memory containing decrypted material
 *     should be discarded as soon as possible; JS doesn't let us truly
 *     zero memory but we limit the surface.
 *
 * Storage format (Base64-URL on each field):
 *   { v: 1, salt, iv, ciphertext }
 *
 * Future upgrade path: when Stronghold lands, replace the passphrase-
 * derived KDF with the OS keychain handle. The serialised JSON shape
 * stays compatible so existing rows can be re-encrypted.
 */

const PBKDF2_ITERATIONS = 200_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const KEY_BITS = 256;

const enc = new TextEncoder();
const dec = new TextDecoder();

export interface EncryptedBlob {
  readonly v: 1;
  readonly salt: string;
  readonly iv: string;
  readonly ciphertext: string;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
): Promise<CryptoKey> {
  if (passphrase.length < 8) {
    throw new Error('Passphrase must be at least 8 characters');
  }
  const baseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(passphrase),
    { name: 'PBKDF2' },
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: KEY_BITS },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptString(
  plaintext: string,
  passphrase: string,
): Promise<EncryptedBlob> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(passphrase, salt);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      enc.encode(plaintext),
    ),
  );
  return {
    v: 1,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(ciphertext),
  };
}

export async function decryptString(
  blob: EncryptedBlob,
  passphrase: string,
): Promise<string> {
  if (blob.v !== 1) {
    throw new Error(`Unsupported encrypted blob version: ${blob.v}`);
  }
  const salt = base64ToBytes(blob.salt);
  const iv = base64ToBytes(blob.iv);
  const ciphertext = base64ToBytes(blob.ciphertext);
  const key = await deriveKey(passphrase, salt);
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertext,
    );
    return dec.decode(plain);
  } catch {
    // AES-GCM throws on bad key OR tampered ciphertext. Don't leak which.
    throw new Error('Decryption failed (wrong passphrase or tampered data)');
  }
}

/** Serialise blob as a single string for SQLite storage. */
export function blobToString(blob: EncryptedBlob): string {
  return JSON.stringify(blob);
}

export function stringToBlob(s: string): EncryptedBlob {
  const parsed = JSON.parse(s);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    parsed.v !== 1 ||
    typeof parsed.salt !== 'string' ||
    typeof parsed.iv !== 'string' ||
    typeof parsed.ciphertext !== 'string'
  ) {
    throw new Error('Invalid encrypted blob shape');
  }
  return parsed as EncryptedBlob;
}
