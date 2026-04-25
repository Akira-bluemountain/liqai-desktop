/**
 * Phase 4.3 — passphrase strength enforcement.
 *
 * We assert:
 *   - Obviously weak passphrases (single word, short, common patterns)
 *     are rejected with `ok: false`.
 *   - Strong passphrases (diceware phrases, long mixed strings) pass
 *     with `ok: true` and entropyBits >= MIN_PASSPHRASE_ENTROPY_BITS.
 *   - The zxcvbn-based estimator is deterministic for the same input.
 *
 * We deliberately do not assert exact bit counts because the zxcvbn
 * dictionary can update between library patch versions and shift
 * estimates by a bit or two. Instead we assert relative properties
 * (rejected vs accepted) and a conservative lower bound on the strong
 * cases.
 */

import { describe, it, expect } from 'vitest';
import {
  evaluatePassphrase,
  MIN_PASSPHRASE_ENTROPY_BITS,
  MIN_PASSPHRASE_LENGTH,
} from '../passphraseStrength';

describe('evaluatePassphrase — rejects weak passphrases', () => {
  it('rejects empty string', () => {
    const r = evaluatePassphrase('');
    expect(r.ok).toBe(false);
    expect(r.label).toBe('too-weak');
  });

  it('rejects short passphrase under MIN_PASSPHRASE_LENGTH', () => {
    const r = evaluatePassphrase('abc123');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(
      new RegExp(`at least ${MIN_PASSPHRASE_LENGTH}`, 'i'),
    );
  });

  it('rejects single common dictionary word (even if ≥ min length)', () => {
    const r = evaluatePassphrase('password1234');
    expect(r.ok).toBe(false);
    expect(r.entropyBits).toBeLessThan(MIN_PASSPHRASE_ENTROPY_BITS);
  });

  it('rejects repeated character patterns', () => {
    const r = evaluatePassphrase('aaaaaaaaaaaa');
    expect(r.ok).toBe(false);
  });

  it('rejects simple keyboard walk', () => {
    const r = evaluatePassphrase('qwerty123456');
    expect(r.ok).toBe(false);
  });

  it('rejects leet substitution of common word', () => {
    const r = evaluatePassphrase('P@ssw0rd!!');
    expect(r.ok).toBe(false);
  });
});

describe('evaluatePassphrase — accepts strong passphrases', () => {
  it('accepts a diceware-style 5+ word phrase', () => {
    const r = evaluatePassphrase('correct horse battery staple ocean');
    expect(r.ok).toBe(true);
    expect(r.entropyBits).toBeGreaterThanOrEqual(MIN_PASSPHRASE_ENTROPY_BITS);
    expect(r.label === 'strong' || r.label === 'excellent').toBe(true);
  });

  it('accepts a long random-looking mixed string', () => {
    const r = evaluatePassphrase('Zx9$kmP3qL#vBn7@rT4wY');
    expect(r.ok).toBe(true);
    expect(r.entropyBits).toBeGreaterThanOrEqual(MIN_PASSPHRASE_ENTROPY_BITS);
  });
});

describe('evaluatePassphrase — determinism + label ladder', () => {
  it('returns the same result for the same input', () => {
    const a = evaluatePassphrase('correct horse battery staple ocean');
    const b = evaluatePassphrase('correct horse battery staple ocean');
    expect(a).toEqual(b);
  });

  it('label ladder matches entropyBits buckets', () => {
    // Boundary checks: the label is derived from entropyBits with these
    // thresholds: too-weak < 30 ≤ weak < 45 ≤ fair < 60 ≤ strong < 80 ≤ excellent.
    const weak = evaluatePassphrase('abc123');
    expect(weak.label).toBe('too-weak');
    const strong = evaluatePassphrase('correct horse battery staple ocean');
    expect(strong.label === 'strong' || strong.label === 'excellent').toBe(
      true,
    );
  });
});
