import { Pipe } from '@angular/core';
import type { PipeTransform } from '@angular/core';

@Pipe({
  name: 'area'
})
export class AreaPipe implements PipeTransform {
  private readonly formatter = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 });

  transform(value: number | null | undefined): string {
    return value == null || !Number.isFinite(value) ? '—' : `${this.formatter.format(value)} m²`;
  }
}
