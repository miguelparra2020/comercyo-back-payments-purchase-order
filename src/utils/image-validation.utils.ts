import { randomUUID } from 'node:crypto';
import sizeOf from 'image-size';

export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

const MIME_TO_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export const ALLOWED_MIME_TYPES = Object.keys(MIME_TO_TYPE);

export type ImageValidationResult =
  | { ok: true; width: number; height: number }
  | { ok: false; message: string };

// Payment receipts are photos/screenshots of arbitrary size, so unlike
// product images there are no dimension limits - only type, size and a
// check that the bytes really are the declared image format.
export const validateImage = (buffer: Buffer, mimeType: string): ImageValidationResult => {
  const expectedType = MIME_TO_TYPE[mimeType];
  if (!expectedType) {
    return { ok: false, message: `Only ${ALLOWED_MIME_TYPES.join(', ')} files are allowed` };
  }

  if (buffer.byteLength > MAX_FILE_SIZE_BYTES) {
    return { ok: false, message: `File must be at most ${MAX_FILE_SIZE_BYTES} bytes` };
  }

  let dimensions;
  try {
    dimensions = sizeOf(buffer);
  } catch {
    return { ok: false, message: 'Could not read image dimensions' };
  }

  const { width, height } = dimensions;
  if (!width || !height) {
    return { ok: false, message: 'Could not read image dimensions' };
  }

  if (dimensions.type !== expectedType) {
    return { ok: false, message: 'File contents do not match the declared image type' };
  }

  return { ok: true, width, height };
};

// Extension-less on purpose: PUT may replace a receipt with a different
// image format, and the real type is kept in the object's Content-Type.
export const generateImageKey = () => randomUUID();
