import sharp from 'sharp';
import { ImageProcessor, InvalidImage, MAX_IMAGE_BYTES } from './image-processor.js';

describe('image processing', () => {
  const processor = new ImageProcessor();

  it('applies orientation, bounds derivatives and removes private metadata', async () => {
    const input = await sharp({
      create: { width: 2000, height: 1000, channels: 3, background: '#547260' }
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    expect((await sharp(input).metadata()).exif).toBeDefined();
    const image = await processor.process(input, 'image/jpeg');
    expect(image.large.width).toBe(960);
    expect(image.large.height).toBe(1920);
    expect(image.thumbnail.width).toBe(240);
    expect(image.thumbnail.height).toBe(480);
    for (const variant of [image.large, image.thumbnail]) {
      const metadata = await sharp(variant.data).metadata();
      expect(metadata.format).toBe('webp');
      expect(metadata.exif).toBeUndefined();
      expect(metadata.icc).toBeUndefined();
      expect(metadata.xmp).toBeUndefined();
      expect(metadata.orientation).toBeUndefined();
    }
  });

  it('accepts genuine PNG and WebP without enlarging small images', async () => {
    for (const format of ['png', 'webp'] as const) {
      const input = await sharp({
        create: { width: 40, height: 30, channels: 4, background: '#54726080' }
      })
        .toFormat(format)
        .toBuffer();
      const image = await processor.process(input, `image/${format}`);
      expect(image.large.width).toBe(40);
      expect(image.large.height).toBe(30);
      expect(image.thumbnail.width).toBe(40);
    }
  });

  it('rejects spoofed image types, non-images and truncated image content', async () => {
    const input = await sharp({
      create: { width: 80, height: 60, channels: 3, background: '#547260' }
    })
      .jpeg()
      .toBuffer();
    await expect(processor.process(input, 'image/png')).rejects.toBeInstanceOf(InvalidImage);
    await expect(
      processor.process(
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"/>'),
        'image/png'
      )
    ).rejects.toBeInstanceOf(InvalidImage);
    await expect(
      processor.process(Buffer.from('not an image'), 'image/jpeg')
    ).rejects.toBeInstanceOf(InvalidImage);
    await expect(
      processor.process(input.subarray(0, Math.floor(input.length / 2)), 'image/jpeg')
    ).rejects.toBeInstanceOf(InvalidImage);
  });

  it('rejects empty, oversized and excessive-dimension images', async () => {
    await expect(processor.process(Buffer.alloc(0), 'image/jpeg')).rejects.toBeInstanceOf(
      InvalidImage
    );
    await expect(
      processor.process(Buffer.alloc(MAX_IMAGE_BYTES + 1), 'image/jpeg')
    ).rejects.toBeInstanceOf(InvalidImage);
    const input = await sharp({
      create: { width: 12_001, height: 1, channels: 3, background: '#547260' }
    })
      .png()
      .toBuffer();
    await expect(processor.process(input, 'image/png')).rejects.toBeInstanceOf(InvalidImage);
  });
});
