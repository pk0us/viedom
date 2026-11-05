import { Pipe } from '@angular/core';
import type { PipeTransform } from '@angular/core';

@Pipe({
  name: 'price'
})
export class PricePipe implements PipeTransform {
  private readonly formatter = new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 2
  });

  transform(value: number | null | undefined): string {
    return value == null || !Number.isFinite(value) ? '—' : this.formatter.format(value);
  }
}
