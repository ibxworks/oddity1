import { EAGER_WORD_LIMIT } from "@oddity/shared";

export function isLongRequest(wordCount: number): boolean {
  return wordCount > EAGER_WORD_LIMIT;
}
