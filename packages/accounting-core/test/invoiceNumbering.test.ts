import { describe, it, expect } from 'vitest';
import { financialYearFor } from '../src/invoiceNumbering';

describe('financialYearFor', () => {
  // India's typical financial year: April 1 - March 31 (startMonth = 4)
  it('places a date after the start month in the year it falls in', () => {
    expect(financialYearFor('2026-07-01', 4)).toBe('2026-2027');
  });

  it('places a date before the start month in the previous financial year', () => {
    expect(financialYearFor('2026-02-01', 4)).toBe('2025-2026');
  });

  it('treats the start month itself as the beginning of the new year', () => {
    expect(financialYearFor('2026-04-01', 4)).toBe('2026-2027');
  });

  it('treats the last day before the start month as still the old year', () => {
    expect(financialYearFor('2026-03-31', 4)).toBe('2025-2026');
  });

  it('works for a calendar-year org too (startMonth = 1)', () => {
    expect(financialYearFor('2026-01-01', 1)).toBe('2026-2027');
    expect(financialYearFor('2026-12-31', 1)).toBe('2026-2027');
  });
});
