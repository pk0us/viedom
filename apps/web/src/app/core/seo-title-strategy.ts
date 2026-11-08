import { DOCUMENT } from '@angular/common';
import { Injectable, inject } from '@angular/core';
import { Meta, Title } from '@angular/platform-browser';
import { TitleStrategy } from '@angular/router';
import type { RouterStateSnapshot } from '@angular/router';
import type { PublicListingDetail } from '@viedom/contracts';
import { publicConfig } from '../../generated/public-config';
import type { PublicListingResult } from './public-listing-resolver';

export function listingPath(listing: Pick<PublicListingDetail, 'id' | 'slug'>): string {
  return `/listings/${encodeURIComponent(listing.id)}/${encodeURIComponent(listing.slug)}`;
}

export function listingStructuredData(listing: PublicListingDetail, url: string) {
  const content = listing.content;
  return {
    '@context': 'https://schema.org',
    '@type': 'RealEstateListing',
    name: content.title,
    description: content.description,
    url,
    datePosted: listing.publishedAt,
    image: content.media.items.map((item) => item.variants.large.url),
    offers: {
      '@type': 'Offer',
      priceCurrency: content.currency,
      price: (content.priceMinor / 100).toFixed(2),
      businessFunction:
        content.transactionType === 'rent'
          ? 'http://purl.org/goodrelations/v1#LeaseOut'
          : 'http://purl.org/goodrelations/v1#Sell',
      url
    },
    about: {
      '@type': content.property.type === 'apartment' ? 'Apartment' : 'Residence',
      numberOfBedrooms: content.property.details.bedrooms,
      numberOfBathroomsTotal: content.property.details.bathrooms,
      floorSize: {
        '@type': 'QuantitativeValue',
        value: content.property.details.areaM2,
        unitCode: 'MTK'
      },
      address: {
        '@type': 'PostalAddress',
        addressLocality: content.property.address.city,
        addressCountry: content.property.address.countryCode
      }
    }
  };
}

@Injectable()
export class SeoTitleStrategy extends TitleStrategy {
  private readonly document = inject(DOCUMENT);
  private readonly title = inject(Title);
  private readonly meta = inject(Meta);

  override updateTitle(snapshot: RouterStateSnapshot): void {
    let route = snapshot.root;
    let noindex = false;
    while (route) {
      noindex ||= route.data['noindex'] === true;
      if (!route.firstChild) break;
      route = route.firstChild;
    }
    const result = route.data['listing'] as PublicListingResult | undefined;
    const listing = result?.listing;
    const path = snapshot.url.split(/[?#]/)[0] ?? '/';
    const url = new URL(listing ? listingPath(listing) : path, publicConfig.webOrigin).href;
    let title = this.buildTitle(snapshot) ?? 'Viedom';
    let description = `Find homes to rent or buy in ${publicConfig.city}. Explore approved listings and approximate locations with Viedom.`;
    if (listing) {
      title = `${listing.content.title} · ${listing.content.property.address.city} · Viedom`;
      description = listing.content.description.replace(/\s+/g, ' ').trim().slice(0, 160);
    } else if (result) {
      noindex = true;
      title = result.unavailable
        ? 'Listing temporarily unavailable · Viedom'
        : 'Listing not found · Viedom';
      description = result.unavailable
        ? 'This listing is temporarily unavailable. Please try again.'
        : 'This listing is no longer available. Explore other homes on Viedom.';
    }
    this.title.setTitle(title);
    this.meta.updateTag({ name: 'description', content: description });
    this.meta.updateTag({
      name: 'robots',
      content: noindex ? 'noindex, nofollow' : 'index, follow'
    });
    for (const [property, content] of Object.entries({
      'og:title': title,
      'og:description': description,
      'og:type': 'website',
      'og:url': url
    }))
      this.meta.updateTag({ property, content });
    this.meta.removeTag('property="og:image"');
    this.document
      .querySelectorAll('link[rel="canonical"],script[data-public-listing]')
      .forEach((node) => node.remove());
    if (!noindex) {
      const canonical = this.document.createElement('link');
      canonical.rel = 'canonical';
      canonical.href = url;
      this.document.head.appendChild(canonical);
    }
    if (listing && !noindex) {
      const image =
        listing.content.media.items.find(
          (item) => item.id === listing.content.media.coverMediaId
        ) ?? listing.content.media.items[0];
      if (image) this.meta.updateTag({ property: 'og:image', content: image.variants.large.url });
      const structured = this.document.createElement('script');
      structured.type = 'application/ld+json';
      structured.setAttribute('data-public-listing', '');
      structured.textContent = JSON.stringify(listingStructuredData(listing, url))
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026');
      this.document.head.appendChild(structured);
    }
  }
}
