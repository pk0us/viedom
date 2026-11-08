export type PipelineStage = Record<string, unknown>;

function gridCoordinate(axis: number, step: number, maximum: number): unknown {
  return {
    $max: [
      -maximum,
      {
        $min: [
          maximum,
          {
            $round: [
              {
                $multiply: [
                  {
                    $add: [
                      {
                        $floor: {
                          $divide: [
                            { $arrayElemAt: ['$property.privateLocation.coordinates', axis] },
                            step
                          ]
                        }
                      },
                      0.5
                    ]
                  },
                  step
                ]
              },
              7
            ]
          }
        ]
      }
    ]
  };
}

function validVariant(name: 'large' | 'thumbnail'): unknown[] {
  const path = `$$asset.variants.${name}`;
  return [
    { $in: [`${path}.key`, '$$asset.processingKeys'] },
    ...(['bytes', 'width', 'height'] as const).flatMap((field) => [
      { $isNumber: `${path}.${field}` },
      { $gt: [`${path}.${field}`, 0] },
      { $lte: [`${path}.${field}`, field === 'bytes' ? 10_485_760 : 1920] },
      { $eq: [`${path}.${field}`, { $trunc: `${path}.${field}` }] }
    ])
  ];
}

export function publicListingMatch(now = new Date()): Record<string, unknown> {
  return {
    status: 'published',
    deletedAt: null,
    moderationHold: false,
    publishedAt: { $ne: null, $lte: now },
    $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
    $expr: {
      $and: [
        { $eq: ['$approvedVersion', '$version'] },
        { $ne: ['$submittedVersion', null] },
        { $lte: ['$submittedVersion', '$version'] },
        { $ne: ['$reviewedById', null] },
        { $ne: ['$reviewedById', '$publisherId'] }
      ]
    }
  };
}

export const markerProjection = {
  _id: 0,
  id: { $toString: '$_id' },
  transactionType: 1,
  priceMinor: 1,
  currency: 1,
  publicLocation: { type: '$publicLocation.type', coordinates: '$publicLocation.coordinates' },
  locationPrecision: { $literal: 'approximate' }
};

export function buildPublicEligibilityPipeline(
  match: Record<string, unknown> = {},
  now = new Date()
): PipelineStage[] {
  const snapshots = [
    ['$propertyVersion', '$property.version'],
    ['$propertyType', '$property.type'],
    ['$areaM2', '$property.details.areaM2'],
    ['$bedrooms', '$property.details.bedrooms'],
    ['$bathrooms', '$property.details.bathrooms'],
    ['$city', '$property.address.city'],
    ['$neighborhood', '$property.address.neighborhood'],
    ['$publisherId', '$property.ownerId']
  ];
  const latitudeStep = 300 / 111_320;
  const longitudeStep = 300 / (111_320 * Math.cos((40.64 * Math.PI) / 180));
  return [
    { $match: { ...publicListingMatch(now), ...match } },
    { $sort: { publishedAt: -1, _id: -1 } },
    {
      $lookup: {
        from: 'users',
        localField: 'publisherId',
        foreignField: '_id',
        as: 'publisher'
      }
    },
    { $unwind: '$publisher' },
    {
      $match: {
        'publisher.status': 'active',
        'publisher.deletedAt': null,
        'publisher.emailVerifiedAt': { $ne: null }
      }
    },
    {
      $lookup: { from: 'properties', localField: 'propertyId', foreignField: '_id', as: 'property' }
    },
    { $unwind: '$property' },
    {
      $match: {
        $expr: {
          $and: [
            ...snapshots.map((pair) => ({ $eq: pair })),
            { $eq: ['$publicLocation.type', 'Point'] },
            {
              $eq: [
                { $arrayElemAt: ['$publicLocation.coordinates', 0] },
                gridCoordinate(0, longitudeStep, 180)
              ]
            },
            {
              $eq: [
                { $arrayElemAt: ['$publicLocation.coordinates', 1] },
                gridCoordinate(1, latitudeStep, 90)
              ]
            }
          ]
        }
      }
    },
    {
      $lookup: {
        from: 'media_galleries',
        localField: '_id',
        foreignField: 'listingId',
        as: 'gallery'
      }
    },
    { $unwind: '$gallery' },
    {
      $match: {
        $expr: {
          $and: [
            { $eq: ['$publisherId', '$gallery.ownerId'] },
            { $gt: [{ $size: '$gallery.mediaIds' }, 0] },
            { $lte: [{ $size: '$gallery.mediaIds' }, 20] },
            {
              $eq: [
                { $size: '$gallery.mediaIds' },
                { $size: { $setUnion: ['$gallery.mediaIds', []] } }
              ]
            },
            { $in: ['$gallery.coverMediaId', '$gallery.mediaIds'] }
          ]
        }
      }
    },
    {
      $set: {
        galleryAssetIds: {
          $map: {
            input: '$gallery.mediaIds',
            as: 'id',
            in: { $convert: { input: '$$id', to: 'objectId', onError: null, onNull: null } }
          }
        }
      }
    },
    {
      $lookup: {
        from: 'media_assets',
        localField: 'galleryAssetIds',
        foreignField: '_id',
        as: 'assets'
      }
    },
    {
      $match: {
        $expr: {
          $and: [
            { $eq: [{ $size: '$assets' }, { $size: '$gallery.mediaIds' }] },
            {
              $allElementsTrue: [
                {
                  $map: {
                    input: '$assets',
                    as: 'asset',
                    in: {
                      $and: [
                        { $eq: ['$$asset.ownerId', '$publisherId'] },
                        { $eq: ['$$asset.listingId', '$_id'] },
                        { $eq: ['$$asset.state', 'ready'] },
                        { $ne: ['$$asset.variants', null] },
                        ...validVariant('large'),
                        ...validVariant('thumbnail')
                      ]
                    }
                  }
                }
              ]
            }
          ]
        }
      }
    }
  ];
}

export function cardProjectionStages(): PipelineStage[] {
  return [
    {
      $set: {
        cover: {
          $arrayElemAt: [
            {
              $filter: {
                input: '$assets',
                as: 'asset',
                cond: {
                  $eq: [{ $toString: '$$asset._id' }, '$gallery.coverMediaId']
                }
              }
            },
            0
          ]
        }
      }
    },
    {
      $project: {
        ...markerProjection,
        title: 1,
        slug: 1,
        propertyType: 1,
        areaM2: 1,
        bedrooms: 1,
        bathrooms: 1,
        city: 1,
        neighborhood: 1,
        publishedAt: 1,
        coverMediaId: '$gallery.coverMediaId',
        coverDimensions: {
          width: '$cover.variants.thumbnail.width',
          height: '$cover.variants.thumbnail.height',
          bytes: '$cover.variants.thumbnail.bytes'
        }
      }
    }
  ];
}
