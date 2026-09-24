import { describe, it, expect } from 'vitest';
import { toPaise, paiseToAmount, sumPaise, addAmounts, isZero } from '../src/money';

describe('money', () => {
  it('converts decimal strings to integer paise without float drift', () => {
    expect(toPaise('19.99')).toBe(1999);
    // The classic float trap: 0.1 + 0.2 !== 0.3 in raw JS numbers. Paise
    // arithmetic must not inherit that.
    expect(toPaise('0.1') + toPaise('0.2')).toBe(30);
  });

  it('sums a list of amounts correctly', () => {
    expect(sumPaise(['100.00', '50.50', '0.50'])).toBe(15100);
  });

  it('round-trips paise back to a 2dp string', () => {
    expect(paiseToAmount(15050)).toBe('150.50');
  });

  it('adds amounts and returns a decimal string', () => {
    expect(addAmounts('10.10', '20.20', '5')).toBe('35.30');
  });

  it('treats 0 and 0.00 as zero, and 0.01 as not zero', () => {
    expect(isZero('0.00')).toBe(true);
    expect(isZero('0')).toBe(true);
    expect(isZero('0.01')).toBe(false);
  });

  it('rejects non-numeric input rather than silently returning NaN', () => {
    expect(() => toPaise('not-a-number')).toThrow();
  });
});
