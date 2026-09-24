/**
 * All amounts in the schema are numeric(14,2) — decimal strings over the
 * wire. Comparing/summing them as JS floats risks classic 0.1 + 0.2 style
 * errors, which is unacceptable for an accounting core. These helpers do
 * every comparison in integer paise instead, and only ever hand Postgres a
 * decimal string.
 */

export function toPaise(amount: string | number): number {
  const n = typeof amount === 'number' ? amount : Number.parseFloat(amount);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid monetary amount: ${amount}`);
  }
  // Round rather than truncate — inputs should already be at 2dp, this just
  // protects against representation noise (e.g. 19.999999999998).
  return Math.round(n * 100);
}

export function paiseToAmount(paise: number): string {
  return (paise / 100).toFixed(2);
}

export function sumPaise(amounts: readonly (string | number)[]): number {
  return amounts.reduce((total: number, a) => total + toPaise(a), 0);
}

export function addAmounts(...amounts: (string | number)[]): string {
  return paiseToAmount(sumPaise(amounts));
}

export function isZero(amount: string | number): boolean {
  return toPaise(amount) === 0;
}
