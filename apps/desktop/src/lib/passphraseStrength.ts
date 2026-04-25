'use client';

/**
 * passphraseStrength — zxcvbn-based entropy estimation with a hard
 * minimum we enforce at session-key install time.
 *
 * CONTEXT (Q2 remediation, Phase 4.3):
 *   The session-key private key is encrypted at rest with a PBKDF2-SHA256
 *   (200,000 iterations) key derived from the user's passphrase. At 2026
 *   GPU/ASIC throughput, PBKDF2-SHA256 is vulnerable to offline dictionary
 *   attacks if the passphrase entropy is low (a weak 8-char alphanumeric
 *   passphrase is crackable in hours, a diceware-5 phrase takes centuries).
 *
 *   Rather than migrate the KDF today (a larger change — Q2's
 *   recommendation is Argon2id via Tauri Stronghold, deferred), we can
 *   close the practical risk surface by enforcing a FLOOR on passphrase
 *   entropy at install time. 60 bits roughly maps to:
 *     - diceware 5 common words (~64.6 bits), or
 *     - 12 random characters across all class (26+26+10+33 = 95 pool ≈
 *       78.8 bits for truly random, ~55 bits typical user input)
 *   Any reasonable user-chosen passphrase should clear 60 bits; this
 *   simply rejects the worst class of picks (single-word dictionary,
 *   repeated patterns, leet substitutions of common words).
 *
 * IMPLEMENTATION:
 *   Uses @zxcvbn-ts/core 3.0.4 with the common + English language packs.
 *   zxcvbn returns a `guessesLog10` which we convert to a bits-entropy
 *   estimate via `log2(10^x) = x * log2(10)`.
 */

import { zxcvbn, zxcvbnOptions } from '@zxcvbn-ts/core';
import * as zxcvbnCommonPackage from '@zxcvbn-ts/language-common';
import * as zxcvbnEnPackage from '@zxcvbn-ts/language-en';

/** Minimum acceptable estimated entropy, in bits.
 *  Matches docs/security-v2.md §S4.3. */
export const MIN_PASSPHRASE_ENTROPY_BITS = 60;

/**
 * Absolute minimum length — even if the character classes are wide, we
 * never accept a passphrase under this length. Defence against zxcvbn
 * giving a surprisingly high score to a short passphrase we haven't
 * anticipated.
 */
export const MIN_PASSPHRASE_LENGTH = 10;

// One-shot init. Loading the dictionaries is a few MB of JSON but only
// happens on first call; subsequent calls reuse the loaded data.
let zxcvbnInitialised = false;
function initZxcvbn(): void {
  if (zxcvbnInitialised) return;
  zxcvbnOptions.setOptions({
    translations: zxcvbnEnPackage.translations,
    graphs: zxcvbnCommonPackage.adjacencyGraphs,
    dictionary: {
      ...zxcvbnCommonPackage.dictionary,
      ...zxcvbnEnPackage.dictionary,
    },
  });
  zxcvbnInitialised = true;
}

export interface PassphraseStrengthResult {
  readonly ok: boolean;
  /** Estimated bits of entropy. */
  readonly entropyBits: number;
  /** zxcvbn score 0-4 (0=too weak, 4=strong). */
  readonly score: 0 | 1 | 2 | 3 | 4;
  /** Short label for UI strength meter. */
  readonly label: 'too-weak' | 'weak' | 'fair' | 'strong' | 'excellent';
  /** User-facing reason if `ok` is false, otherwise an encouragement message. */
  readonly message: string;
  /** Concrete suggestion (from zxcvbn) if any. */
  readonly suggestion?: string;
}

/**
 * Evaluate a passphrase. Returns a structured result indicating whether
 * it meets the MVP floor. Callers MUST check `ok` and block install when
 * false.
 */
export function evaluatePassphrase(
  passphrase: string,
): PassphraseStrengthResult {
  initZxcvbn();

  if (passphrase.length === 0) {
    return {
      ok: false,
      entropyBits: 0,
      score: 0,
      label: 'too-weak',
      message: 'Enter a passphrase.',
    };
  }

  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    return {
      ok: false,
      entropyBits: 0,
      score: 0,
      label: 'too-weak',
      message: `Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`,
      suggestion:
        'Use a long random string or a diceware phrase of 5+ words.',
    };
  }

  const result = zxcvbn(passphrase);
  // guessesLog10 is the base-10 logarithm of the estimated number of guesses
  // an attacker needs. log2(10^x) = x * log2(10) ≈ x * 3.3219.
  const entropyBits = result.guessesLog10 * Math.log2(10);
  const score = result.score as 0 | 1 | 2 | 3 | 4;

  const label: PassphraseStrengthResult['label'] =
    entropyBits < 30
      ? 'too-weak'
      : entropyBits < 45
      ? 'weak'
      : entropyBits < 60
      ? 'fair'
      : entropyBits < 80
      ? 'strong'
      : 'excellent';

  if (entropyBits < MIN_PASSPHRASE_ENTROPY_BITS) {
    return {
      ok: false,
      entropyBits,
      score,
      label,
      message:
        `Passphrase entropy ${entropyBits.toFixed(1)} bits is below the ` +
        `${MIN_PASSPHRASE_ENTROPY_BITS}-bit minimum.`,
      suggestion:
        result.feedback.suggestions[0] ??
        'Try a diceware phrase (5+ random words) or a 14+ character mixed string.',
    };
  }

  return {
    ok: true,
    entropyBits,
    score,
    label,
    message: `Estimated entropy: ${entropyBits.toFixed(1)} bits (${label}).`,
  };
}
