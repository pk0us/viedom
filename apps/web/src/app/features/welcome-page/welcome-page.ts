import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { UiState } from '../../shared/ui-state/ui-state';
import { publicConfig } from '../../../generated/public-config';

@Component({
  imports: [RouterLink, NzButtonModule, UiState],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-welcome-page',
  styleUrl: './welcome-page.scss',
  templateUrl: './welcome-page.html'
})
export class WelcomePage {
  readonly city = publicConfig.city;
}
