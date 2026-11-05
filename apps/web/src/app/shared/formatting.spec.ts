import { AreaPipe } from './area-pipe';
import { PricePipe } from './price-pipe';

describe('marketplace display formatting', () => {
  const price = new PricePipe();
  const area = new AreaPipe();

  it('uses en-GB separators, EUR and square metres without losing cents', () => {
    expect(price.transform(1234.56)).toBe('€1,234.56');
    expect(price.transform(0)).toBe('€0.00');
    expect(area.transform(1234.5)).toBe('1,234.5 m²');
    expect(area.transform(0)).toBe('0 m²');
  });

  it('distinguishes missing and non-finite values from zero', () => {
    for (const value of [null, undefined, NaN, Infinity]) {
      expect(price.transform(value)).toBe('—');
      expect(area.transform(value)).toBe('—');
    }
  });
});
