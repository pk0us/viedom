/** Transport-only types. Persistence and server configuration never belong here. */
export interface PublicConfig {
  readonly apiBaseUrl: string;
  readonly locale: string;
  readonly currency: 'EUR';
  readonly city: string;
  readonly map: {
    readonly longitude: number;
    readonly latitude: number;
    readonly zoom: number;
    readonly styleUrl: string;
  };
}

export interface HealthResponse {
  status: 'ok';
  service: 'viedom-api';
}

export interface ReadinessResponse {
  status: 'ready' | 'not_ready';
}

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    requestId: string;
    fields?: { path: string; code: string }[];
  };
}

export interface CurrentUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: 'USER' | 'ADMIN';
  emailVerified: boolean;
}
export interface RegisterRequest {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
}
export interface LoginRequest {
  email: string;
  password: string;
}
export interface CsrfResponse {
  csrfToken: string;
}
export interface AuthResponse extends CsrfResponse {
  accessToken: string;
  expiresIn: number;
  user: CurrentUser;
}
export interface GoogleStartResponse {
  authorizationUrl: string;
}
export interface EmailActionRequest {
  email: string;
}
export interface ConfirmEmailRequest {
  token: string;
}
export interface ResetPasswordRequest extends ConfirmEmailRequest {
  password: string;
}
export interface EmailActionResponse {
  message: string;
}

export type PropertyType = 'apartment' | 'house' | 'studio';
export type ListingStatus =
  'draft' | 'pending_review' | 'rejected' | 'published' | 'paused' | 'archived';
export interface GeoPoint {
  type: 'Point';
  coordinates: [number, number];
}
export interface PropertyContent {
  type: PropertyType;
  details: {
    areaM2: number;
    bedrooms: number;
    bathrooms: number;
    floor: number;
    yearBuilt: number | null;
    amenities: string[];
  };
  address: { countryCode: 'GR'; city: string; neighborhood: string; street: string };
  privateLocation: GeoPoint;
}
export interface VersionRequest {
  expectedVersion: number;
}
export interface UpdatePropertyRequest extends PropertyContent, VersionRequest {}
export interface OwnerProperty extends PropertyContent {
  id: string;
  version: number;
  publicLocation: GeoPoint;
  createdAt: string;
  updatedAt: string;
}
export interface ListingContent {
  transactionType: 'rent' | 'sale';
  title: string;
  description: string;
  priceMinor: number;
  currency: 'EUR';
}
export interface CreateListingRequest extends ListingContent {
  propertyId: string;
  expectedPropertyVersion: number;
}
export interface UpdateListingRequest extends ListingContent, VersionRequest {}
export type SubmissionRequirement =
  | 'verifiedEmail'
  | 'title'
  | 'description'
  | 'bathrooms'
  | 'processedMedia'
  | 'moderationHold'
  | 'state';
export interface OwnerListingSummary extends ListingContent {
  id: string;
  propertyId: string;
  version: number;
  propertyVersion: number;
  status: ListingStatus;
  moderationHold: boolean;
  submittedVersion: number | null;
  rejectionReason?: string | null;
  publishedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface OwnerListingDetail extends OwnerListingSummary {
  property: OwnerProperty;
  submission: { canSubmit: boolean; missing: SubmissionRequirement[] };
}
export interface OwnerListingsResponse {
  items: OwnerListingSummary[];
  nextCursor: string | null;
}

export interface SearchBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}
export interface ListingSearchFilters {
  transactionType?: 'rent' | 'sale';
  minPrice?: number;
  maxPrice?: number;
  minBedrooms?: number;
  minAreaM2?: number;
  propertyType?: PropertyType;
}
export interface ListingSearchQuery extends SearchBounds, ListingSearchFilters {
  cursor?: string;
  limit?: number;
}
export interface ListingMarkersQuery extends SearchBounds, ListingSearchFilters {}
export interface PublicListingMarker {
  id: string;
  transactionType: 'rent' | 'sale';
  priceMinor: number;
  currency: 'EUR';
  publicLocation: GeoPoint;
  locationPrecision: 'approximate';
}
export interface PublicListingCard extends PublicListingMarker {
  title: string;
  slug: string;
  propertyType: PropertyType;
  areaM2: number;
  bedrooms: number;
  bathrooms: number;
  city: string;
  neighborhood: string;
  publishedAt: string;
  coverImage: MediaVariant;
}
export interface ListingSearchResponse {
  items: PublicListingCard[];
  nextCursor: string | null;
}
export interface ListingMarkersResponse {
  items: PublicListingMarker[];
  capped: boolean;
  limit: number;
}

export interface RejectListingRequest extends VersionRequest {
  reason: string;
}
export type AdminListingsResponse = OwnerListingsResponse;
export interface AdminModerationEvent {
  id: string;
  reviewerId: string;
  reviewedVersion: number;
  resultVersion: number;
  decision: 'approved' | 'rejected';
  reason: string | null;
  createdAt: string;
}
export interface AdminListingDetail {
  listing: OwnerListingDetail;
  publisher: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    emailVerified: boolean;
    active: boolean;
  };
  media: OwnerMediaGallery;
  canDecide: boolean;
  canApprove: boolean;
  history: AdminModerationEvent[];
}
export interface AdminDecisionResponse {
  id: string;
  version: number;
  status: 'published' | 'rejected';
  rejectionReason: string | null;
}

export interface ListingPreviewContent extends ListingContent {
  property: {
    type: PropertyType;
    details: PropertyContent['details'];
    address: { countryCode: 'GR'; city: string; neighborhood: string };
    publicLocation: GeoPoint;
  };
  media: {
    coverMediaId: string | null;
    items: { id: string; variants: { large: MediaVariant; thumbnail: MediaVariant } }[];
  };
}
export interface OwnerListingPreview {
  version: number;
  status: ListingStatus;
  submission: { canSubmit: boolean; missing: SubmissionRequirement[] };
  content: ListingPreviewContent;
}

export type MediaState =
  'awaiting_upload' | 'queued' | 'processing' | 'ready' | 'failed' | 'deleted';
export type UploadContentType = 'image/jpeg' | 'image/png' | 'image/webp';
export interface MediaVariant {
  url: string;
  width: number;
  height: number;
  bytes: number;
  contentType: 'image/webp';
}
export interface OwnerMediaAsset {
  id: string;
  state: MediaState;
  errorCode: 'invalid_image' | 'processing_failed' | null;
  variants: { large: MediaVariant; thumbnail: MediaVariant } | null;
}
export interface OwnerMediaGallery {
  listingId: string;
  version: number;
  coverMediaId: string | null;
  items: OwnerMediaAsset[];
}
export interface MediaUploadRequest extends VersionRequest {
  contentType: UploadContentType;
  bytes: number;
}
export interface MediaUploadResponse {
  mediaId: string;
  uploadUrl: string;
  expiresAt: string;
  headers: { 'Content-Type': UploadContentType };
  gallery: OwnerMediaGallery;
}
export interface MediaCompleteRequest extends VersionRequest {
  mediaId: string;
}
export interface UpdateMediaGalleryRequest extends VersionRequest {
  mediaIds: string[];
  coverMediaId: string | null;
}
