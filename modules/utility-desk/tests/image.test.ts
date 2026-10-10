import { describe, it, expect } from 'vitest';
import { encodeWithinLimit, grayscale, sepia, contrast, sharpen, clampCrop, rotatedSize, sizeImage, detectUnsupportedImage } from '../src/lib/imageops';

const px = (...v: number[]) => new Uint8ClampedArray(v);

describe('image transformations', () => {
  it('grayscale equalises channels', () => {
    const d = px(255, 0, 0, 255); grayscale(d);
    expect(d[0]).toBe(d[1]); expect(d[1]).toBe(d[2]); expect(d[0]).toBe(76);
  });
  it('sepia tints white', () => { const d = px(255, 255, 255, 255); sepia(d); expect(d[0]).toBe(255); expect(d[2]).toBeLessThan(d[0]); });
  it('contrast pushes values apart and 0 is neutral', () => {
    const a = px(100, 200, 128, 255); contrast(a, 50);
    expect(a[0]).toBeLessThan(100); expect(a[1]).toBeGreaterThan(200); expect(a[2]).toBe(128);
    const b = px(100, 200, 128, 255); contrast(b, 0); expect(Array.from(b)).toEqual([100, 200, 128, 255]);
  });
  it('sharpen keeps flat areas and enhances edges', () => {
    const flat = new Uint8ClampedArray(3 * 3 * 4).fill(100); sharpen(flat, 3, 3, 0.5);
    expect(flat[16]).toBe(100);
    const e = new Uint8ClampedArray(3 * 3 * 4).fill(100); e[16] = 150; sharpen(e, 3, 3, 0.5);
    expect(e[16]).toBeGreaterThan(150);
  });
  it('geometry helpers', () => {
    expect(clampCrop({ x: -5, y: 90, width: 500, height: 50 }, 100, 100)).toEqual({ x: 0, y: 90, width: 100, height: 10 });
    expect(rotatedSize(100, 50, 90)).toEqual([50, 100]);
    expect(rotatedSize(100, 50, 180)).toEqual([100, 50]);
    expect(sizeImage(200, 100, 100, undefined, 'maximum', false)).toMatchObject({ width: 100, height: 50 });
    expect(sizeImage(200, 100, undefined, undefined, 'maximum', false)).toMatchObject({ width: 200, height: 100 });
  });
  it('flags HEIC', () => {
    expect(detectUnsupportedImage({ name: 'a.HEIC', type: '' })).toMatch(/HEIC/);
    expect(detectUnsupportedImage({ name: 'a.png', type: 'image/png' })).toBeNull();
  });
});

describe('max file size', () => {
  const fake = (q: number) => Promise.resolve(new Blob([new Uint8Array(Math.round(q * 10000))]));
  it('keeps start quality when it already fits', async () => { expect((await encodeWithinLimit(fake, 0.9, 20000)).size).toBe(9000); });
  it('finds the highest quality under the limit', async () => {
    const b = await encodeWithinLimit(fake, 0.9, 5000);
    expect(b.size).toBeLessThanOrEqual(5000); expect(b.size).toBeGreaterThan(4800);
  });
  it('fails when the limit is unreachable', async () => { await expect(encodeWithinLimit(fake, 0.9, 99)).rejects.toThrow(/Nothing was saved/); });
});
