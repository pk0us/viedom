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
