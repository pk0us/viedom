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
