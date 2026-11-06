import { Injectable } from '@nestjs/common';
import sharp from 'sharp';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_GALLERY_IMAGES = 20;
export const UPLOAD_SECONDS = 300;
export const PROCESSING_LEASE_MS = 120_000;
export const CLEANUP_GRACE_MS = 60_000;
export const MAX_PROCESSING_ATTEMPTS = 5;

export class InvalidImage extends Error {}

export interface ProcessedImage {
  large: { data: Buffer; width: number; height: number };
  thumbnail: { data: Buffer; width: number; height: number };
}

@Injectable()
export class ImageProcessor {
  async process(input: Buffer, contentType: string): Promise<ProcessedImage> {
    if (!input.length || input.length > MAX_IMAGE_BYTES) throw new InvalidImage();
    const jpeg = input.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
    const png = input.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]));
    const webp =
      input.toString('ascii', 0, 4) === 'RIFF' && input.toString('ascii', 8, 12) === 'WEBP';
    if (!(
      (contentType === 'image/jpeg' && jpeg) ||
      (contentType === 'image/png' && png) ||
      (contentType === 'image/webp' && webp)
    ))
      throw new InvalidImage();
    if (png) {
      for (let offset = 8; offset + 12 <= input.length;) {
        if (input.toString('ascii', offset + 4, offset + 8) === 'acTL') throw new InvalidImage();
        offset += 12 + input.readUInt32BE(offset);
      }
    }
    try {
      const options = { failOn: 'warning' as const, limitInputPixels: 40_000_000 };
      const metadata = await sharp(input, options).metadata();
      const types: Record<string, string> = {
        jpeg: 'image/jpeg',
        png: 'image/png',
        webp: 'image/webp'
      };
      if (
        !metadata.format ||
        types[metadata.format] !== contentType ||
        !metadata.width ||
        !metadata.height ||
        metadata.width > 12_000 ||
        metadata.height > 12_000 ||
        metadata.width * metadata.height > 40_000_000 ||
        (metadata.pages ?? 1) !== 1
      )
        throw new InvalidImage();
      const render = async (size: number) => {
        const { data, info } = await sharp(input, options)
          .autoOrient()
          .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 82, effort: 4 })
          .timeout({ seconds: 30 })
          .toBuffer({ resolveWithObject: true });
        return { data, width: info.width, height: info.height };
      };
      return { large: await render(1920), thumbnail: await render(480) };
    } catch (error) {
      if (error instanceof InvalidImage) throw error;
      throw new InvalidImage();
    }
  }
}
