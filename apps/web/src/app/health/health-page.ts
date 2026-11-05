import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { NzAlertModule } from 'ng-zorro-antd/alert';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { publicConfig } from '../../generated/public-config';
import { HealthClient } from './health-client';
import { UiState } from '../shared/ui-state/ui-state';

@Component({
  selector: 'app-health-page',
  imports: [NzAlertModule, NzButtonModule, UiState],
  templateUrl: './health-page.html',
  styleUrl: './health-page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class HealthPage {
  readonly client = inject(HealthClient);
  readonly city = publicConfig.city;
}
