// Lets `bun test` run the unit tests when `claude plugin test` is unavailable.
// @ts-expect-error bun types are not part of the mod's type roots
export { describe, expect, test } from 'bun:test'
