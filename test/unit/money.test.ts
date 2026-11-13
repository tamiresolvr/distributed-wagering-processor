import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/money';
import { CurrencyMismatchError, InvalidMoneyError } from '../../src/domain/errors';

describe('Money', () => {
  test('parses and serialises with fixed scale 2', () => {
    expect(Money.from({ amount: '25', currency: 'BRL' }).toString()).toBe('25.00');
    expect(Money.from({ amount: '25.5', currency: 'BRL' }).toJSON()).toEqual({ amount: '25.50', currency: 'BRL' });
    expect(Money.zero('BRL').toString()).toBe('0.00');
  });

  test('is exact where floats are not (0.10 + 0.20)', () => {
    const a = Money.from({ amount: '0.10', currency: 'BRL' });
    const b = Money.from({ amount: '0.20', currency: 'BRL' });
    expect(a.add(b).toString()).toBe('0.30');
    expect(a.add(b).equals(Money.from({ amount: '0.30', currency: 'BRL' }))).toBe(true);
  });

  test('handles very large values without precision loss', () => {
    const big = Money.from({ amount: '999999999999999999.99', currency: 'BRL' });
    expect(big.add(Money.from({ amount: '0.01', currency: 'BRL' })).toString()).toBe('1000000000000000000.00');
  });

  test('is immutable: operations return new instances', () => {
    const a = Money.from({ amount: '10.00', currency: 'BRL' });
    const b = a.subtract(Money.from({ amount: '3.00', currency: 'BRL' }));
    expect(a.toString()).toBe('10.00');
    expect(b.toString()).toBe('7.00');
  });

  test('derived values can be negative, inputs cannot', () => {
    const a = Money.from({ amount: '1.00', currency: 'BRL' });
    const n = a.subtract(Money.from({ amount: '2.50', currency: 'BRL' }));
    expect(n.isNegative()).toBe(true);
    expect(n.toString()).toBe('-1.50');
    expect(n.negate().toString()).toBe('1.50');
    expect(() => Money.from({ amount: '-1.00', currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  test('comparisons', () => {
    const a = Money.from({ amount: '1.00', currency: 'BRL' });
    const b = Money.from({ amount: '1.01', currency: 'BRL' });
    expect(a.isLessThan(b)).toBe(true);
    expect(b.isLessThan(a)).toBe(false);
    expect(a.isZero()).toBe(false);
    expect(a.isPositive()).toBe(true);
  });

  test.each(['', 'NaN', 'Infinity', '-Infinity', '1e3', '1E3', '1.234', '.5', '5.', '+5', '1,00', ' 1.00', '0x10', '--1'])(
    'rejects invalid amount %p',
    (amount) => {
      expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(InvalidMoneyError);
    },
  );

  test('rejects non-string amounts (number is never accepted)', () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
    expect(() => Money.from(null as never)).toThrow(InvalidMoneyError);
  });

  test('rejects invalid currency', () => {
    expect(() => Money.from({ amount: '1.00', currency: 'brl' })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: '1.00', currency: 'REAL' })).toThrow(InvalidMoneyError);
  });

  test('currency conflicts raise a domain error on every binary operation', () => {
    const brl = Money.from({ amount: '1.00', currency: 'BRL' });
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.isLessThan(usd)).toThrow(CurrencyMismatchError);
    expect(brl.equals(usd)).toBe(false);
  });
});
