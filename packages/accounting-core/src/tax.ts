import { and, eq, gte, isNull, lte, or, desc, type SQL } from 'drizzle-orm';
import { taxRates } from '@platform/db';
import type { Tx } from './accounts';
import { AccountingError } from './errors';
import { toPaise, paiseToAmount } from './money';

export interface ResolvedTaxRate {
  id: string;
  cgstRate: string;
  sgstRate: string;
  igstRate: string;
}

/**
 * "HSN + transaction date -> exactly one applicable rate" (ADR-005 /
 * Tax-Rate Versioning Mechanism). The EXCLUDE constraint in the DB
 * guarantees no overlap *within* a scope (an org's own overrides, or the
 * shared platform-default scope); this function implements the precedence
 * *between* those two scopes: try the org's own override for the date
 * first, fall back to the platform default.
 */
export async function resolveTaxRate(
  tx: Tx,
  organizationId: string,
  hsnCode: string,
  onDate: string,
): Promise<ResolvedTaxRate> {
  const activeForDate = (orgFilter: SQL) =>
    and(
      orgFilter,
      eq(taxRates.hsnCode, hsnCode),
      lte(taxRates.effectiveFrom, onDate),
      or(isNull(taxRates.effectiveTo), gte(taxRates.effectiveTo, onDate)),
    );

  const [orgRate] = await tx
    .select()
    .from(taxRates)
    .where(activeForDate(eq(taxRates.organizationId, organizationId)))
    .orderBy(desc(taxRates.effectiveFrom))
    .limit(1);
  if (orgRate) return orgRate;

  const [platformRate] = await tx
    .select()
    .from(taxRates)
    .where(activeForDate(isNull(taxRates.organizationId)))
    .orderBy(desc(taxRates.effectiveFrom))
    .limit(1);
  if (platformRate) return platformRate;

  throw new AccountingError(
    `No tax rate configured for HSN '${hsnCode}' on ${onDate} (checked org override and platform default).`,
    'TAX_RATE_NOT_FOUND',
  );
}

export interface LineTaxInput {
  quantity: number;
  rate: string; // per-unit price, decimal string
  discountAmount: string; // absolute discount on the line, decimal string
  taxRate: Pick<ResolvedTaxRate, 'cgstRate' | 'sgstRate' | 'igstRate'>;
  isInterState: boolean; // org.stateCode !== counterparty state -> IGST, else CGST+SGST
}

export interface LineTaxResult {
  taxableValue: string;
  cgstAmount: string;
  sgstAmount: string;
  igstAmount: string;
  lineTotal: string;
}

/**
 * Rounding rule (documented per ADR-005): each line is rounded independently
 * to 2 decimal places, round-half-up, computed in integer paise throughout
 * so no floating-point drift enters the figure that gets posted to the
 * ledger. See test/tax.test.ts for the worked examples this was checked
 * against before being wired into confirmSale/confirmPurchase.
 */
export function calculateLineTax(input: LineTaxInput): LineTaxResult {
  const grossPaise = Math.round(input.quantity) * toPaise(input.rate);
  const discountPaise = toPaise(input.discountAmount);
  const taxablePaise = grossPaise - discountPaise;

  if (taxablePaise < 0) {
    throw new AccountingError('Discount cannot exceed the line amount.', 'INVALID_DISCOUNT');
  }

  const cgstRatePct = Number.parseFloat(input.taxRate.cgstRate);
  const sgstRatePct = Number.parseFloat(input.taxRate.sgstRate);
  const igstRatePct = Number.parseFloat(input.taxRate.igstRate);

  let cgstPaise = 0;
  let sgstPaise = 0;
  let igstPaise = 0;

  if (input.isInterState) {
    igstPaise = Math.round((taxablePaise * igstRatePct) / 100);
  } else {
    cgstPaise = Math.round((taxablePaise * cgstRatePct) / 100);
    sgstPaise = Math.round((taxablePaise * sgstRatePct) / 100);
  }

  const lineTotalPaise = taxablePaise + cgstPaise + sgstPaise + igstPaise;

  return {
    taxableValue: paiseToAmount(taxablePaise),
    cgstAmount: paiseToAmount(cgstPaise),
    sgstAmount: paiseToAmount(sgstPaise),
    igstAmount: paiseToAmount(igstPaise),
    lineTotal: paiseToAmount(lineTotalPaise),
  };
}
