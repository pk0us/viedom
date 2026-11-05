import { ChangeDetectionStrategy, Component } from '@angular/core';
import { UiState } from '../../shared/ui-state/ui-state';

@Component({
  imports: [UiState],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-owner-overview',
  styleUrl: './owner-overview.scss',
  templateUrl: './owner-overview.html'
})
export class OwnerOverview {}
