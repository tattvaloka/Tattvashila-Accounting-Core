import { describe, it, expect } from 'vitest';
import { calculateLineTax } from '../src/tax';

const rate18 = { cgstRate: '9.00', sgstRate: '9.00', igstRate: '18.00' };
const rate5 = { cgstRate: '2.50', sgstRate: '2.50', igstRate: '5.00' };

describe('calculateLineTax', () => {
  it('splits an intra-state line into CGST + SGST, IGST zero', () => {
    // 10 pairs @ ₹500, ₹250 discount, 18% GST
    const r = calculateLineTax({ quantity: 10, rate: '500.00', discountAmount: '250.00', taxRate: rate18, isInterState: false });
    expect(r).toEqual({
      taxableValue: '4750.00',
      cgstAmount: '427.50',
      sgstAmount: '427.50',
      igstAmount: '0.00',
      lineTotal: '5605.00',
    });
  });

  it('puts the same total tax entirely into IGST for an inter-state line', () => {
    const r = calculateLineTax({ quantity: 10, rate: '500.00', discountAmount: '250.00', taxRate: rate18, isInterState: true });
    expect(r).toEqual({
      taxableValue: '4750.00',
      cgstAmount: '0.00',
      sgstAmount: '0.00',
      igstAmount: '855.00',
      lineTotal: '5605.00',
    });
    // Inter-state and intra-state must always agree on the total for the
    // same taxable value and combined rate — only the split differs.
  });

  it('rounds each side independently (round-half-up) rather than splitting a combined figure', () => {
    // 3 x ₹33.33 = ₹99.99 taxable; 9% of that is 8.9991, which rounds to 9.00
    const r = calculateLineTax({ quantity: 3, rate: '33.33', discountAmount: '0.00', taxRate: rate18, isInterState: false });
    expect(r).toEqual({
      taxableValue: '99.99',
      cgstAmount: '9.00',
      sgstAmount: '9.00',
      igstAmount: '0.00',
      lineTotal: '117.99',
    });
  });

  it('handles the footwear <₹1000 5% GST slab', () => {
    const r = calculateLineTax({ quantity: 1, rate: '1000.00', discountAmount: '0.00', taxRate: rate5, isInterState: false });
    expect(r).toEqual({
      taxableValue: '1000.00',
      cgstAmount: '25.00',
      sgstAmount: '25.00',
      igstAmount: '0.00',
      lineTotal: '1050.00',
    });
  });

  it('rejects a discount larger than the line amount', () => {
    expect(() =>
      calculateLineTax({ quantity: 1, rate: '100.00', discountAmount: '150.00', taxRate: rate18, isInterState: false }),
    ).toThrow(/discount/i);
  });

  it('returns all zeros for a fully discounted (free) line, without erroring', () => {
    const r = calculateLineTax({ quantity: 2, rate: '50.00', discountAmount: '100.00', taxRate: rate18, isInterState: false });
    expect(r.taxableValue).toBe('0.00');
    expect(r.lineTotal).toBe('0.00');
  });
});
