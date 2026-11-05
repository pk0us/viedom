import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

@Component({
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-not-found',
  styleUrl: './not-found.scss',
  templateUrl: './not-found.html'
})
export class NotFound {}
