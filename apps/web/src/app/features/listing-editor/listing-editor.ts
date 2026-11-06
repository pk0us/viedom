import { DOCUMENT } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  FormField,
  applyEach,
  form,
  maxLength,
  required,
  submit,
  validate
} from '@angular/forms/signals';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { NzButtonModule } from 'ng-zorro-antd/button';
import type { OwnerListingDetail, OwnerProperty } from '@viedom/contracts';
import { AuthSession } from '../../core/auth/auth-session';
import { FieldFeedback } from '../../shared/field-feedback/field-feedback';
import { UiState } from '../../shared/ui-state/ui-state';
import { invalid, messages } from '../auth/auth-feedback';
import { LocationPicker } from '../location-picker/location-picker';
import { OwnerListingsClient } from '../owner-listings-client';
import {
  draftFromDetail,
  emptyDraft,
  listingContent,
  priceMinor,
  propertyContent,
  sameContent
} from './listing-editor-model';

@Component({
  selector: 'app-listing-editor',
  imports: [FormField, RouterLink, NzButtonModule, FieldFeedback, UiState, LocationPicker],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './listing-editor.html',
  styleUrl: './listing-editor.scss',
  host: { '(window:beforeunload)': 'beforeUnload($event)' }
})
export class ListingEditor {
  private readonly api = inject(OwnerListingsClient);
  private readonly session = inject(AuthSession);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly window = inject(DOCUMENT).defaultView;
  private readonly destroyRef = inject(DestroyRef);
  private epoch = 0;
  private listingId: string | null = null;
  private createdProperty: OwnerProperty | null = null;
  private baseline = signal(emptyDraft());
  readonly model = signal(emptyDraft());
  readonly detail = signal<OwnerListingDetail | null>(null);
  readonly loading = signal(false);
  readonly busy = signal(false);
  readonly loadError = signal('');
  readonly error = signal('');
  readonly success = signal('');
  readonly reloadRequired = signal(false);
  readonly uncertainCreation = signal(false);
  readonly dirty = computed(() => !sameContent(this.model(), this.baseline()));
  readonly archived = computed(() => this.detail()?.status === 'archived');
  readonly invalid = invalid;
  readonly messages = messages;
  readonly fields = form(this.model, (path) => {
    required(path.area, { message: 'Enter the property area.' });
    required(path.city, { message: 'Enter the city.' });
    validate(path.city, ({ value }) =>
      value().trim() ? undefined : { kind: 'blank', message: 'Enter the city.' }
    );
    maxLength(path.city, 100);
    maxLength(path.neighborhood, 100);
    maxLength(path.street, 200);
    maxLength(path.title, 160);
    maxLength(path.description, 10_000);
    const numeric = [
      { path: path.area, min: 1, max: 100_000, integer: false },
      { path: path.bedrooms, min: 0, max: 100, integer: true },
      { path: path.bathrooms, min: 0, max: 100, integer: true },
      { path: path.floor, min: -10, max: 200, integer: true },
      { path: path.longitude, min: -180, max: 180, integer: false },
      { path: path.latitude, min: -90, max: 90, integer: false }
    ];
    for (const item of numeric)
      validate(item.path, ({ value }) => {
        const text = value().trim();
        const number = Number(text);
        return !/^-?\d+(?:\.\d+)?$/.test(text) ||
          !Number.isFinite(number) ||
          number < item.min ||
          number > item.max ||
          (item.integer && !Number.isInteger(number))
          ? {
              kind: 'number',
              message: `Enter ${item.integer ? 'a whole number' : 'a number'} from ${item.min} to ${item.max}.`
            }
          : undefined;
      });
    validate(path.year, ({ value }) => {
      const text = value().trim();
      return text && (!/^\d{4}$/.test(text) || Number(text) < 1800 || Number(text) > 2100)
        ? { kind: 'year', message: 'Enter a year from 1800 to 2100, or leave it blank.' }
        : undefined;
    });
    validate(path.amenities, ({ value }) => {
      const values = value();
      return values.length > 30 ||
        new Set(values).size !== values.length ||
        values.some((item) => !item || item.length > 50)
        ? { kind: 'amenities', message: 'Use up to 30 unique amenities, each 1–50 characters.' }
        : undefined;
    });
    applyEach(path.amenities, (amenity) => {
      required(amenity, { message: 'Enter an amenity or remove this field.' });
      maxLength(amenity, 50, { message: 'Use at most 50 characters.' });
    });
    required(path.price, { message: 'Enter the price in euros.' });
    validate(path.price, ({ value }) =>
      priceMinor(value()) === null
        ? {
            kind: 'money',
            message:
              'Enter €0.01–€1,000,000,000.00 using a decimal point and at most two decimal places.'
          }
        : undefined
    );
  });

  constructor() {
    this.route.paramMap.pipe(takeUntilDestroyed()).subscribe((params) => {
      this.listingId = params.get('id');
      this.createdProperty = null;
      this.detail.set(null);
      this.model.set(emptyDraft());
      this.baseline.set(emptyDraft());
      this.reloadRequired.set(false);
      this.uncertainCreation.set(false);
      this.error.set('');
      this.success.set('');
      void this.load();
    });
    effect(() => {
      if (!this.session.user()) {
        this.epoch++;
        this.detail.set(null);
        this.createdProperty = null;
        this.model.set(emptyDraft());
        this.baseline.set(emptyDraft());
        this.busy.set(false);
      }
    });
    this.destroyRef.onDestroy(() => {
      this.epoch++;
    });
  }

  private current(epoch: number, identity: number): boolean {
    return (
      epoch === this.epoch && identity === this.session.identityVersion() && !!this.session.user()
    );
  }

  private apply(detail: OwnerListingDetail): void {
    this.detail.set(detail);
    const model = draftFromDetail(detail);
    this.model.set(model);
    this.baseline.set(model);
    this.fields().reset();
  }

  async load(): Promise<void> {
    const epoch = ++this.epoch;
    const identity = this.session.identityVersion();
    this.loadError.set('');
    this.loading.set(!!this.listingId);
    if (!this.listingId) return;
    try {
      if (!/^[a-f0-9]{24}$/.test(this.listingId)) throw new HttpErrorResponse({ status: 404 });
      const detail = await this.api.detail(this.listingId);
      if (this.current(epoch, identity)) {
        this.apply(detail);
        this.reloadRequired.set(false);
        this.error.set('');
      }
    } catch (error) {
      if (this.current(epoch, identity))
        this.loadError.set(
          error instanceof HttpErrorResponse && error.status === 404
            ? 'This listing is unavailable or does not belong to your account.'
            : 'Your listing could not be loaded. Please try again.'
        );
    } finally {
      if (this.current(epoch, identity)) this.loading.set(false);
    }
  }

  async reload(): Promise<void> {
    if (this.busy() || this.uncertainCreation()) return;
    if (
      this.dirty() &&
      !this.window?.confirm('Discard your unsaved changes and reload saved data?')
    )
      return;
    if (!this.listingId) {
      if (this.createdProperty) {
        const epoch = this.epoch;
        const identity = this.session.identityVersion();
        this.busy.set(true);
        try {
          const property = await this.api.getProperty(this.createdProperty.id);
          if (!this.current(epoch, identity)) return;
          this.createdProperty = property;
          this.reloadRequired.set(false);
          this.error.set('The saved property was reloaded. Check your draft and save again.');
        } catch {
          if (this.current(epoch, identity))
            this.error.set(
              'The saved property could not be reloaded. Return to your listings and check before saving again.'
            );
        } finally {
          if (this.current(epoch, identity)) this.busy.set(false);
        }
      } else await this.router.navigateByUrl('/owner');
      return;
    }
    await this.load();
  }

  locationChanged(location: { longitude: number; latitude: number }): void {
    if (this.busy() || this.archived() || this.reloadRequired()) return;
    this.model.update((model) => ({
      ...model,
      longitude: String(location.longitude),
      latitude: String(location.latitude)
    }));
  }

  addAmenity(): void {
    if (
      this.busy() ||
      this.archived() ||
      this.reloadRequired() ||
      this.model().amenities.length >= 30
    )
      return;
    this.model.update((model) => ({ ...model, amenities: [...model.amenities, ''] }));
  }

  removeAmenity(index: number): void {
    if (this.busy() || this.archived() || this.reloadRequired()) return;
    this.model.update((model) => ({
      ...model,
      amenities: model.amenities.filter((_, item) => item !== index)
    }));
  }

  async save(event: Event): Promise<void> {
    event.preventDefault();
    if (
      this.busy() ||
      this.archived() ||
      this.reloadRequired() ||
      this.loadError() ||
      this.loading()
    )
      return;
    this.error.set('');
    this.success.set('');
    await submit(this.fields, async () => {
      const epoch = this.epoch;
      const identity = this.session.identityVersion();
      this.busy.set(true);
      let wrote = false;
      let creatingListing = false;
      try {
        const model = this.model();
        const property = propertyContent(model);
        const listing = listingContent(model);
        let existing = this.detail();
        if (!existing) {
          if (!this.createdProperty) {
            const created = await this.api.createProperty(property);
            if (!this.current(epoch, identity)) return;
            this.createdProperty = created;
            wrote = true;
          } else if (!sameContent(property, this.editableProperty(this.createdProperty))) {
            const updated = await this.api.updateProperty(this.createdProperty.id, {
              ...property,
              expectedVersion: this.createdProperty.version
            });
            if (!this.current(epoch, identity)) return;
            this.createdProperty = updated;
            wrote = true;
          }
          creatingListing = true;
          const created = await this.api.createListing({
            ...listing,
            propertyId: this.createdProperty.id,
            expectedPropertyVersion: this.createdProperty.version
          });
          creatingListing = false;
          if (!this.current(epoch, identity)) return;
          this.listingId = created.id;
          wrote = true;
        } else {
          if (!sameContent(property, this.editableProperty(existing.property))) {
            const expectedListingVersion = existing.version + 1;
            await this.api.updateProperty(existing.property.id, {
              ...property,
              expectedVersion: existing.property.version
            });
            if (!this.current(epoch, identity)) return;
            wrote = true;
            existing = await this.api.detail(existing.id);
            if (!this.current(epoch, identity)) return;
            if (existing.version !== expectedListingVersion)
              throw new HttpErrorResponse({ status: 409 });
            this.detail.set(existing);
          }
          if (!sameContent(listing, this.editableListing(existing))) {
            await this.api.updateListing(existing.id, {
              ...listing,
              expectedVersion: existing.version
            });
            if (!this.current(epoch, identity)) return;
            wrote = true;
          }
        }
        const saved = await this.api.detail(this.listingId!);
        if (!this.current(epoch, identity)) return;
        this.apply(saved);
        this.success.set('Listing saved. You can reopen it from My listings.');
        this.busy.set(false);
        if (this.route.snapshot.paramMap.get('id') !== saved.id) {
          await this.router.navigate(['/owner/listings', saved.id], { replaceUrl: true });
          if (!this.destroyRef.destroyed && identity === this.session.identityVersion())
            this.success.set('Listing saved. You can reopen it from My listings.');
        }
      } catch (error) {
        if (!this.current(epoch, identity)) return;
        const status = error instanceof HttpErrorResponse ? error.status : 0;
        if (creatingListing && (status === 0 || status >= 500)) this.uncertainCreation.set(true);
        if (status === 409 || status === 0 || status >= 500 || wrote) {
          this.reloadRequired.set(true);
          this.error.set(
            'This listing changed or the save outcome is uncertain. Reload saved data before making further changes.'
          );
        } else if (status === 404) {
          this.reloadRequired.set(true);
          this.error.set(
            'This listing or property is no longer available to your account. Reload saved data before continuing.'
          );
        } else if (status === 400)
          this.error.set(
            'The server could not accept these values. Check your draft and try again.'
          );
        else if (status === 403)
          this.error.set(
            'Your account cannot save this draft. Refresh your account status or sign in again.'
          );
        else if (status !== 401) this.error.set('The draft could not be saved. Please try again.');
      } finally {
        if (this.current(epoch, identity)) this.busy.set(false);
      }
    });
    if (this.fields().invalid()) {
      this.error.set('Please check the highlighted fields.');
      const first = [
        this.fields.area,
        this.fields.bedrooms,
        this.fields.bathrooms,
        this.fields.floor,
        this.fields.year,
        ...this.fields.amenities,
        this.fields.city,
        this.fields.neighborhood,
        this.fields.street,
        this.fields.longitude,
        this.fields.latitude,
        this.fields.title,
        this.fields.description,
        this.fields.price
      ].find((field) => field().invalid());
      first?.().focusBoundControl();
      if (!first && this.fields.amenities().invalid())
        this.fields.amenities[0]?.().focusBoundControl();
    }
  }

  private editableProperty(property: OwnerProperty) {
    return {
      type: property.type,
      details: property.details,
      address: property.address,
      privateLocation: property.privateLocation
    };
  }
  private editableListing(listing: OwnerListingDetail) {
    return {
      transactionType: listing.transactionType,
      title: listing.title,
      description: listing.description,
      priceMinor: listing.priceMinor,
      currency: listing.currency
    };
  }

  canLeave(): boolean {
    if (!this.session.user()) return true;
    if (this.busy()) return false;
    return !this.dirty() || !!this.window?.confirm('Leave without saving your changes?');
  }
  beforeUnload(event: BeforeUnloadEvent): void {
    if (this.session.user() && (this.dirty() || this.busy())) {
      event.preventDefault();
      event.returnValue = '';
    }
  }
}
