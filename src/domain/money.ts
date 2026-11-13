import { CurrencyMismatchError, InvalidMoneyError } from './errors';

/** DTO: decimal string with fixed scale 2 + ISO-4217 code. */
export interface MoneyProps {
  amount: string;
  currency: string;
}

const AMOUNT_RE = /^\d{1,18}(\.\d{1,2})?$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

/**
 * Immutable monetary value. Internally an exact integer count of minor units
 * (bigint) — no number/float is ever involved. Scale is fixed at 2.
 */
export class Money {
  private constructor(
    private readonly minor: bigint,
    public readonly currency: string,
  ) {}

  /** Parses an *input* contract: non-negative decimal string, at most 2 decimals. */
  static from(props: MoneyProps): Money {
    if (props === null || typeof props !== 'object') throw new InvalidMoneyError('money must be an object');
    const { amount, currency } = props;
    if (typeof amount !== 'string') throw new InvalidMoneyError('amount must be a decimal string');
    if (typeof currency !== 'string' || !CURRENCY_RE.test(currency)) {
      throw new InvalidMoneyError('currency must be an ISO-4217 code');
    }
    // Rejects: empty, NaN, Infinity, scientific notation, signs, >2 decimals.
    if (!AMOUNT_RE.test(amount)) throw new InvalidMoneyError(`invalid amount "${amount}"`);
    const [int, frac = ''] = amount.split('.');
    return new Money(BigInt(int!) * 100n + BigInt(frac.padEnd(2, '0')), currency);
  }

  /** Builds a value from minor units (may be negative: used for derived arithmetic). */
  static ofMinor(minor: bigint, currency: string): Money {
    if (!CURRENCY_RE.test(currency)) throw new InvalidMoneyError('currency must be an ISO-4217 code');
    return new Money(minor, currency);
  }

  static zero(currency: string): Money {
    return Money.ofMinor(0n, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor + other.minor, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor - other.minor, this.currency);
  }

  negate(): Money {
    return new Money(-this.minor, this.currency);
  }

  isZero(): boolean {
    return this.minor === 0n;
  }
  isPositive(): boolean {
    return this.minor > 0n;
  }
  isNegative(): boolean {
    return this.minor < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor < other.minor;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minor === other.minor;
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  /** Decimal string, always 2 decimals. */
  toString(): string {
    const neg = this.minor < 0n;
    const abs = neg ? -this.minor : this.minor;
    const int = abs / 100n;
    const frac = (abs % 100n).toString().padStart(2, '0');
    return `${neg ? '-' : ''}${int}.${frac}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) throw new CurrencyMismatchError(this.currency, other.currency);
  }
}
