// SPDX-License-Identifier: Apache-2.0

/**
 * A BCP 47 tag as Polyant keys localized text: language, optional script,
 * optional region (`it-IT`, `en-US`, `zh-Hant-TW`). Casing is canonical so two
 * spellings of one locale cannot both appear in a map. The engine validates
 * with the same pattern.
 */
export const LOCALE_TAG_PATTERN = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|\d{3}))?$/;

/**
 * Text a person reads in the admin panel or the marketplace: one string per
 * locale, or a plain string that stands for every locale. The panel shows the
 * reader's tag, else the same language, else English, else the first tag
 * alphabetically, so a map should carry at least `en-US`.
 *
 * Text the model reads (a tool's `description`, `inputExamples`) is never
 * localized: it stays one string.
 */
export type LocalizedText = string | Readonly<Record<string, string>>;

/**
 * Throw when `value` is not a valid {@link LocalizedText}: an empty string, an
 * empty map, a tag that is not canonical BCP 47, or an empty entry. Runs at
 * module load, like the `requiredSecrets` checks, so a typo fails the plugin's
 * own tests instead of the engine's manifest validation.
 */
export function assertLocalizedText(value: unknown, where: string): asserts value is LocalizedText {
  if (typeof value === "string") {
    if (value.length === 0) throw new Error(`${where} is an empty string.`);
    return;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${where} must be a string or a map of BCP 47 tags to strings.`);
  }
  const entries = Object.entries(value);
  if (entries.length === 0) throw new Error(`${where} must name at least one locale.`);
  for (const [tag, text] of entries) {
    if (!LOCALE_TAG_PATTERN.test(tag)) {
      throw new Error(`${where} uses "${tag}", which is not a canonical BCP 47 tag such as en-US or it-IT.`);
    }
    if (typeof text !== "string" || text.length === 0) {
      throw new Error(`${where}["${tag}"] must be a non-empty string.`);
    }
  }
}
