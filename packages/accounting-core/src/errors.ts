/**
 * Thrown for any violation of an accounting invariant (unbalanced posting,
 * editing a confirmed transaction, over-returning a line, etc.). Kept
 * separate from generic errors so the API layer can map it to a 4xx with a
 * clear message instead of a raw 500.
 */
export class AccountingError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'AccountingError';
  }
}
