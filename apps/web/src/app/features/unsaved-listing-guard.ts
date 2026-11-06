import type { CanDeactivateFn } from '@angular/router';

export interface UnsavedListing {
  canLeave(): boolean;
}

export const unsavedListingGuard: CanDeactivateFn<UnsavedListing> = (component) =>
  component.canLeave();
