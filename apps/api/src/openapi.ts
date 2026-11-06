import { Controller, Get } from '@nestjs/common';

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required
});
const string = (maxLength: number, minLength = 0) => ({ type: 'string', minLength, maxLength });
const integer = (minimum: number, maximum: number) => ({ type: 'integer', minimum, maximum });
const id = { type: 'string', pattern: '^[a-f0-9]{24}$' };
const date = { type: 'string', format: 'date-time' };
const version = integer(1, Number.MAX_SAFE_INTEGER);
const expectedVersion = integer(1, Number.MAX_SAFE_INTEGER - 1);
const nullable = (schema: object) => ({ anyOf: [schema, { type: 'null' }] });
const point = object({
  type: { const: 'Point' },
  coordinates: {
    type: 'array',
    prefixItems: [
      { type: 'number', minimum: -180, maximum: 180 },
      { type: 'number', minimum: -90, maximum: 90 }
    ],
    minItems: 2,
    maxItems: 2
  }
});
const property = {
  type: { enum: ['apartment', 'house', 'studio'] },
  details: object({
    areaM2: { type: 'number', minimum: 1, maximum: 100_000 },
    bedrooms: integer(0, 100),
    bathrooms: integer(0, 100),
    floor: integer(-10, 200),
    yearBuilt: nullable(integer(1800, 2100)),
    amenities: { type: 'array', maxItems: 30, uniqueItems: true, items: string(50, 1) }
  }),
  address: object({
    countryCode: { const: 'GR' },
    city: string(100, 1),
    neighborhood: string(100),
    street: string(200)
  }),
  privateLocation: point
};
const listing = {
  transactionType: { enum: ['rent', 'sale'] },
  title: string(160),
  description: string(10_000),
  priceMinor: { ...integer(1, 100_000_000_000), description: 'Integer EUR cents.' },
  currency: { const: 'EUR' }
};
const summary = {
  ...listing,
  id,
  propertyId: id,
  version,
  propertyVersion: version,
  status: { enum: ['draft', 'pending_review', 'rejected', 'published', 'paused', 'archived'] },
  moderationHold: { type: 'boolean' },
  submittedVersion: nullable(version),
  publishedAt: nullable(date),
  expiresAt: nullable(date),
  createdAt: date,
  updatedAt: date
};
const json = (schema: unknown) => ({ 'application/json': { schema } });
function operation(
  operationId: string,
  response: string,
  body?: string,
  created = false,
  description?: string
) {
  return {
    operationId,
    description,
    security: [{ bearerAuth: [] }],
    ...(body ? { requestBody: { required: true, content: json(ref(body)) } } : {}),
    responses: {
      [created ? '201' : '200']: {
        description: 'Success. Private responses use no-store, noindex and no-referrer.',
        content: json(ref(response))
      },
      ...Object.fromEntries(
        [400, 401, 403, 404, 409].map((status) => [
          String(status),
          {
            description: (
              {
                400: 'Invalid input, including unknown fields.',
                401: 'Invalid or missing bearer session.',
                403: 'Account or verification denied.',
                404: 'Missing or not owned.',
                409: 'Stale version, incomplete draft or invalid transition.'
              } as Record<number, string>
            )[status],
            content: json(ref('ApiError'))
          }
        ])
      )
    }
  };
}
const parameter = { name: 'id', in: 'path', required: true, schema: id };
export const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'Viedom owner property and listing API',
    version: '0.8.0',
    description:
      'Phase 08 contracts. Bearer authentication only; cookies do not authorize owner operations. PATCH replaces all editable content. Duplicate actions conflict; clients must reload after 409. Publication is reserved for later administrative endpoints. No public listing read is exposed in this phase.'
  },
  servers: [{ url: '/api' }],
  paths: {
    '/properties': { post: operation('createProperty', 'OwnerProperty', 'PropertyContent', true) },
    '/properties/{id}': {
      parameters: [parameter],
      get: operation('readOwnProperty', 'OwnerProperty'),
      patch: operation(
        'updateOwnProperty',
        'OwnerProperty',
        'UpdateProperty',
        false,
        'Atomically updates all snapshots and withdraws nonterminal listings to draft. Requires expected canonical version.'
      )
    },
    '/listings': {
      post: operation(
        'createListing',
        'OwnerListingDetail',
        'CreateListing',
        true,
        'Creates a draft; property must belong to caller and match expectedPropertyVersion. Maximum 100 listings per property, including archived records.'
      )
    },
    '/listings/{id}': {
      parameters: [parameter],
      patch: operation(
        'updateOwnListing',
        'OwnerListingDetail',
        'UpdateListing',
        false,
        'Withdraws any reviewed content to draft. Archived listings are terminal. Clients cannot set ownership, publication, media or expiration fields.'
      )
    },
    '/me/listings': {
      get: {
        ...operation('listOwnListings', 'OwnerListings'),
        parameters: [
          { name: 'limit', in: 'query', schema: { ...integer(1, 50), default: 20 } },
          {
            name: 'cursor',
            in: 'query',
            schema: { ...string(256, 1), pattern: '^[A-Za-z0-9_-]+$' },
            description: 'Opaque continuation cursor, stable createdAt and ID descending ordering.'
          },
          { name: 'status', in: 'query', schema: summary.status }
        ]
      }
    },
    '/me/listings/{id}': {
      parameters: [parameter],
      get: operation('readOwnListing', 'OwnerListingDetail')
    },
    ...Object.fromEntries(
      ['submit', 'pause', 'resume', 'archive'].map((action) => [
        `/listings/{id}/${action}`,
        {
          parameters: [parameter],
          post: operation(
            `${action}OwnListing`,
            'OwnerListingDetail',
            'VersionRequest',
            false,
            action === 'submit' || action === 'resume'
              ? 'Verified active owner; valid draft/rejected (submit) or paused (resume). Requires title >=10, description >=30, >=1 bathroom and owned processed photos. Phase 08 has no processed-media implementation, so submission fails closed with 409. Transitions to pending_review only.'
              : action === 'pause'
                ? 'Published to paused; withdraws approval. Resuming requires review.'
                : 'Any nonterminal state to archived. Terminal; moderation holds are preserved.'
          )
        }
      ])
    )
  },
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    schemas: {
      PropertyContent: object(property),
      UpdateProperty: object({ ...property, expectedVersion }),
      OwnerProperty: object({
        ...property,
        id,
        version,
        publicLocation: point,
        createdAt: date,
        updatedAt: date
      }),
      CreateListing: object({
        ...listing,
        propertyId: id,
        expectedPropertyVersion: expectedVersion
      }),
      UpdateListing: object({ ...listing, expectedVersion }),
      VersionRequest: object({ expectedVersion }),
      OwnerListingSummary: object(summary),
      OwnerListingDetail: object({
        ...summary,
        property: ref('OwnerProperty'),
        submission: object({
          canSubmit: { type: 'boolean' },
          missing: {
            type: 'array',
            items: {
              enum: [
                'verifiedEmail',
                'title',
                'description',
                'bathrooms',
                'processedMedia',
                'moderationHold',
                'state'
              ]
            }
          }
        })
      }),
      OwnerListings: object({
        items: { type: 'array', maxItems: 50, items: ref('OwnerListingSummary') },
        nextCursor: nullable(string(256, 1))
      }),
      ApiError: object({
        error: object({
          code: { type: 'string' },
          message: { type: 'string' },
          requestId: { type: 'string' }
        })
      })
    }
  }
};

@Controller('openapi.json')
export class OpenApiController {
  @Get() read() {
    return openApiDocument;
  }
}
