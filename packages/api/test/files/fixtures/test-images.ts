/**
 * RV-006 — Runtime-generated image fixtures.
 *
 * Tiny solid-color test images produced with sharp at test time so no
 * binary fixtures are committed. `orientation` writes the EXIF
 * orientation tag (6 = 90° CW) so tests can assert the pipeline applies
 * the rotation to pixels and strips the tag.
 */
import sharp from 'sharp';

export interface FixtureImageOptions {
  width?: number;
  height?: number;
  background?: string;
  /** EXIF orientation tag (1–8). Omit for none. */
  orientation?: number;
}

function base(opts: FixtureImageOptions) {
  return sharp({
    create: {
      width: opts.width ?? 100,
      height: opts.height ?? 60,
      channels: 3,
      background: opts.background ?? '#3366cc',
    },
  });
}

export async function makeJpeg(opts: FixtureImageOptions = {}): Promise<Buffer> {
  let pipeline = base(opts).jpeg();
  if (opts.orientation) pipeline = pipeline.withMetadata({ orientation: opts.orientation });
  return pipeline.toBuffer();
}

export async function makePng(opts: FixtureImageOptions = {}): Promise<Buffer> {
  return base(opts).png().toBuffer();
}

export async function makeWebp(opts: FixtureImageOptions = {}): Promise<Buffer> {
  return base(opts).webp().toBuffer();
}
