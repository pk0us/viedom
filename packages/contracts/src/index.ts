/** Transport-only types. Persistence and server configuration never belong here. */
export interface PublicConfig {
  readonly apiBaseUrl: string;
  readonly locale: string;
  readonly currency: 'EUR';
  readonly city: string;
  readonly map: { readonly longitude: number; readonly latitude: number; readonly zoom: number };
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
