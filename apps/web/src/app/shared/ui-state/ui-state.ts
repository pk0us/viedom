import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { NzAlertModule } from 'ng-zorro-antd/alert';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzEmptyModule } from 'ng-zorro-antd/empty';
import { NzSpinModule } from 'ng-zorro-antd/spin';

@Component({
  imports: [NzAlertModule, NzButtonModule, NzEmptyModule, NzSpinModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-ui-state',
  styleUrl: './ui-state.scss',
  templateUrl: './ui-state.html'
})
export class UiState {
  readonly kind = input.required<'loading' | 'empty' | 'error'>();
  readonly heading = input.required<string>();
  readonly description = input.required<string>();
  readonly retryLabel = input('');
  readonly retry = output<void>();
}
