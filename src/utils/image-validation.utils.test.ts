import { describe, it, expect } from 'vitest';
import { validateImage, generateImageKey, MAX_FILE_SIZE_BYTES } from './image-validation.utils';

function makePngBuffer(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(33);
  buffer.write('\x89PNG\r\n\x1a\n', 0, 'binary');
  buffer.writeUInt32BE(13, 8); // IHDR chunk length
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

describe('validateImage', () => {
  it('rejects a mime type that is not an allowed image type', () => {
    const result = validateImage(Buffer.from('not an image'), 'application/pdf');
    expect(result).toEqual({
      ok: false,
      message: 'Only image/jpeg, image/png, image/webp files are allowed',
    });
  });

  it('rejects a file larger than 10MB', () => {
    const result = validateImage(Buffer.alloc(MAX_FILE_SIZE_BYTES + 1), 'image/png');
    expect(result.ok).toBe(false);
  });

  it('rejects a file whose content does not match its declared mime type', () => {
    const result = validateImage(makePngBuffer(800, 600), 'image/jpeg');
    expect(result).toEqual({ ok: false, message: 'File contents do not match the declared image type' });
  });

  it('rejects bytes that are not an image at all', () => {
    const result = validateImage(Buffer.from('hello world'), 'image/png');
    expect(result.ok).toBe(false);
  });

  it('accepts small and very large receipts alike (no dimension limits)', () => {
    expect(validateImage(makePngBuffer(120, 80), 'image/png')).toEqual({ ok: true, width: 120, height: 80 });
    expect(validateImage(makePngBuffer(4032, 3024), 'image/png')).toEqual({ ok: true, width: 4032, height: 3024 });
  });

  it('generates unique extension-less UUID keys', () => {
    const key1 = generateImageKey();
    const key2 = generateImageKey();
    expect(key1).toMatch(/^[0-9a-f-]{36}$/);
    expect(key1).not.toBe(key2);
  });
});
