import { afterNextRender, ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AuthSession } from '../../core/auth/auth-session';

@Component({
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-callback-page',
  styleUrl: './callback-page.scss',
  templateUrl: './callback-page.html'
})
export class CallbackPage {
  private readonly session = inject(AuthSession);
  private readonly router = inject(Router);
  readonly failed = signal(false);

  constructor() {
    afterNextRender(() => {
      void this.finish();
    });
  }

  private async finish(): Promise<void> {
    try {
      if (await this.session.restore())
        await this.router.navigateByUrl('/owner', { replaceUrl: true });
      else this.failed.set(true);
    } catch {
      this.failed.set(true);
    }
  }
}
