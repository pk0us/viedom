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
  rejectionReason: nullable(string(2000, 1)),
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
    title: 'Viedom property, listing and administrative review API',
    version: '0.12.0',
    description:
      'Bearer authentication only; cookies do not authorize owner operations. PATCH replaces all editable content. Stale mutations conflict; clients must reload after 409. Original uploads are private. Processed images require owner authorization or current publication eligibility.'
  },
  servers: [{ url: '/api' }],
  paths: {
    '/admin/listings/pending': {
      get: {
        ...operation(
          'listPendingListings',
          'AdminListings',
          undefined,
          false,
          'Active ADMIN and live bearer session required. Private pending queue with stable createdAt and ID descending ordering.'
        ),
        parameters: [
          { name: 'limit', in: 'query', schema: { ...integer(1, 50), default: 20 } },
          {
            name: 'cursor',
            in: 'query',
            schema: { ...string(256, 1), pattern: '^[A-Za-z0-9_-]+$' }
          }
        ]
      }
    },
    '/admin/listings/{id}': {
      parameters: [parameter],
      get: operation(
        'reviewListing',
        'AdminListingDetail',
        undefined,
        false,
        'Active ADMIN and live bearer session required. Explicit private review projection includes private address and coordinates, publisher eligibility, protected processed photos and latest 20 audit events. canDecide allows rejection of the current pending submission; canApprove additionally requires publication completeness.'
      )
    },
    '/admin/listings/{id}/approve': {
      parameters: [parameter],
      post: operation(
        'approveListing',
        'AdminDecision',
        'VersionRequest',
        false,
        'Active ADMIN and live bearer session required. Cannot decide own submission. Requires exact pending submitted version, current eligible publisher, consistent canonical property, no deletion/hold/expiry and complete validated processed media. Atomically publishes reviewed content with 90-day expiry and inserts immutable audit evidence. Stale or concurrent decisions conflict.'
      )
    },
    '/admin/listings/{id}/reject': {
      parameters: [parameter],
      post: operation(
        'rejectListing',
        'AdminDecision',
        'RejectListing',
        false,
        'Active ADMIN and live bearer session required. Cannot decide own submission. Requires exact pending submitted version and no deletion or moderation hold. Publication incompleteness does not prevent rejection. Trims the reason; atomically records private owner feedback and audit evidence.'
      )
    },
    '/admin/listings/{id}/media/{mediaId}/{variant}': {
      parameters: [
        parameter,
        { name: 'mediaId', in: 'path', required: true, schema: id },
        { name: 'variant', in: 'path', required: true, schema: { enum: ['large', 'thumbnail'] } }
      ],
      get: {
        operationId: 'readReviewProcessedImage',
        security: [{ bearerAuth: [] }],
        description:
          'Active ADMIN and live bearer session required. Rechecks current listing, gallery and authorization after storage read. Delivers processed derivatives only.',
        responses: {
          '200': {
            description: 'Authorized sanitized image; no-store, noindex and no-referrer.',
            content: { 'image/webp': { schema: { type: 'string', format: 'binary' } } }
          },
          '401': { description: 'Invalid or missing bearer session.' },
          '403': { description: 'Administrator access denied.' },
          '404': { description: 'Listing or validated processed derivative unavailable.' }
        }
      }
    },
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
    '/me/listings/{id}/preview': {
      parameters: [parameter],
      get: operation(
        'previewOwnListing',
        'OwnerListingPreview',
        undefined,
        false,
        'Owner-only saved-content preview with status and submission readiness outside the intended public field projection. Omits street, private coordinates, account/property IDs and unprocessed images. Image URLs still require the owner bearer session. Previewing never publishes.'
      )
    },
    '/listings/{id}/media': {
      parameters: [parameter],
      get: operation('readOwnMedia', 'OwnerMediaGallery'),
      patch: operation(
        'orderOwnMedia',
        'OwnerMediaGallery',
        'UpdateMediaGallery',
        false,
        'Reorders the exact existing gallery IDs and selects a processed cover. Withdraws reviewed content. Use the returned listing version for later writes.'
      )
    },
    '/listings/{id}/media/upload-url': {
      parameters: [parameter],
      post: operation(
        'authorizeMediaUpload',
        'MediaUploadResponse',
        'MediaUploadRequest',
        true,
        'Reserves one of at most 20 gallery slots. Upload JPEG, PNG or WebP bytes to the returned private PUT URL within five minutes using the returned headers. Maximum 10 MiB. Actual content is validated during processing.'
      )
    },
    '/listings/{id}/media/complete': {
      parameters: [parameter],
      post: operation(
        'completeMediaUpload',
        'OwnerMediaGallery',
        'MediaCompleteRequest',
        false,
        'Queues durable image processing. Duplicate completion for a queued, processing or ready owned asset returns current state. Processing changes advance the listing version; poll the gallery before another mutation.'
      )
    },
    '/listings/{id}/media/{mediaId}': {
      parameters: [parameter, { name: 'mediaId', in: 'path', required: true, schema: id }],
      delete: operation(
        'deleteOwnMedia',
        'OwnerMediaGallery',
        'VersionRequest',
        false,
        'Withdraws reviewed content immediately, removes the gallery reference and schedules durable object cleanup. Archived listings are terminal.'
      )
    },
    '/listings/{id}/media/{mediaId}/{variant}': {
      parameters: [
        parameter,
        { name: 'mediaId', in: 'path', required: true, schema: id },
        { name: 'variant', in: 'path', required: true, schema: { enum: ['large', 'thumbnail'] } }
      ],
      get: {
        operationId: 'readOwnProcessedImage',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': {
            description: 'Authorized sanitized image; no-store.',
            content: { 'image/webp': { schema: { type: 'string', format: 'binary' } } }
          },
          '404': { description: 'Image missing, unprocessed or not owned.' }
        }
      }
    },
    '/media/{id}/{mediaId}/{variant}': {
      parameters: [
        parameter,
        { name: 'mediaId', in: 'path', required: true, schema: id },
        { name: 'variant', in: 'path', required: true, schema: { enum: ['large', 'thumbnail'] } }
      ],
      get: {
        operationId: 'readPublishedImage',
        security: [],
        description:
          'Rechecks current listing, owner and processed gallery eligibility on every request. No original or public bucket access.',
        responses: {
          '200': {
            description: 'Eligible sanitized image; no-store.',
            content: { 'image/webp': { schema: { type: 'string', format: 'binary' } } }
          },
          '404': { description: 'Image or current listing publication unavailable.' }
        }
      }
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
              ? 'Verified active owner; valid draft/rejected (submit) or paused (resume). Requires title >=10, description >=30, >=1 bathroom and a valid owned processed gallery and cover. Transitions to pending_review only.'
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
      RejectListing: object({
        expectedVersion,
        reason: {
          ...string(2000, 1),
          description:
            'Trimmed before validation and persistence; must contain at least one non-whitespace character.'
        }
      }),
      AdminDecision: object({
        id,
        version,
        status: { enum: ['published', 'rejected'] },
        rejectionReason: nullable(string(2000, 1))
      }),
      AdminListings: object({
        items: { type: 'array', maxItems: 50, items: ref('OwnerListingSummary') },
        nextCursor: nullable(string(256, 1))
      }),
      AdminModerationEvent: object({
        id,
        reviewerId: id,
        reviewedVersion: expectedVersion,
        resultVersion: integer(2, Number.MAX_SAFE_INTEGER),
        decision: { enum: ['approved', 'rejected'] },
        reason: nullable(string(2000, 1)),
        createdAt: date
      }),
      AdminListingDetail: object({
        listing: ref('OwnerListingDetail'),
        publisher: object({
          id,
          email: { ...string(254, 3), format: 'email' },
          firstName: string(100, 1),
          lastName: string(100, 1),
          emailVerified: { type: 'boolean' },
          active: { type: 'boolean' }
        }),
        media: ref('OwnerMediaGallery'),
        canDecide: { type: 'boolean' },
        canApprove: { type: 'boolean' },
        history: { type: 'array', maxItems: 20, items: ref('AdminModerationEvent') }
      }),
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
      ListingPreviewContent: object({
        ...listing,
        property: object({
          type: property.type,
          details: property.details,
          address: object({
            countryCode: { const: 'GR' },
            city: string(100, 1),
            neighborhood: string(100)
          }),
          publicLocation: point
        }),
        media: object({
          coverMediaId: nullable(id),
          items: {
            type: 'array',
            maxItems: 20,
            items: object({
              id,
              variants: object({ large: ref('MediaVariant'), thumbnail: ref('MediaVariant') })
            })
          }
        })
      }),
      OwnerListingPreview: object({
        version,
        status: summary.status,
        submission: ref('SubmissionReadiness'),
        content: ref('ListingPreviewContent')
      }),
      SubmissionReadiness: object({
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
      }),
      MediaVariant: object({
        url: { type: 'string' },
        width: integer(1, 1920),
        height: integer(1, 1920),
        bytes: integer(1, 10_485_760),
        contentType: { const: 'image/webp' }
      }),
      OwnerMediaAsset: object({
        id,
        state: { enum: ['awaiting_upload', 'queued', 'processing', 'ready', 'failed', 'deleted'] },
        errorCode: { enum: [null, 'invalid_image', 'processing_failed'] },
        variants: nullable(object({ large: ref('MediaVariant'), thumbnail: ref('MediaVariant') }))
      }),
      OwnerMediaGallery: object({
        listingId: id,
        version,
        coverMediaId: nullable(id),
        items: { type: 'array', maxItems: 20, items: ref('OwnerMediaAsset') }
      }),
      MediaUploadRequest: object({
        expectedVersion,
        contentType: { enum: ['image/jpeg', 'image/png', 'image/webp'] },
        bytes: integer(1, 10_485_760)
      }),
      MediaUploadResponse: object({
        mediaId: id,
        uploadUrl: { type: 'string', format: 'uri' },
        expiresAt: date,
        headers: object({ 'Content-Type': { enum: ['image/jpeg', 'image/png', 'image/webp'] } }),
        gallery: ref('OwnerMediaGallery')
      }),
      MediaCompleteRequest: object({ expectedVersion, mediaId: id }),
      UpdateMediaGallery: object({
        expectedVersion,
        mediaIds: { type: 'array', maxItems: 20, uniqueItems: true, items: id },
        coverMediaId: nullable(id)
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
