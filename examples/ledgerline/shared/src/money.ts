/** Integer minor units (cents) + ISO currency code. */
export interface Money {
  amount: number;
  currency: string;
}

export function zeroMoney(currency = "USD"): Money {
  return { amount: 0, currency };
}

export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) {
    throw new Error(`Currency mismatch: ${a.currency} vs ${b.currency}`);
  }
  return { amount: a.amount + b.amount, currency: a.currency };
}

export function multiplyMoney(m: Money, factor: number): Money {
  return { amount: Math.round(m.amount * factor), currency: m.currency };
}

export function negateMoney(m: Money): Money {
  return { amount: -m.amount, currency: m.currency };
}
