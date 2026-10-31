import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { requiredEnv } from '../utils/env.utils';

// Payment receipts live in a PRIVATE bucket, one folder per purchase order:
//   purchase-orders/{orderId}/{receiptKey}
export const R2_PREFIX = 'purchase-orders/';

export const DEFAULT_SIGNED_URL_TTL_SECONDS = 900;

let client: S3Client | undefined;

export const getR2Client = () => {
  if (client) {
    return client;
  }

  client = new S3Client({
    region: 'auto',
    endpoint: `https://${requiredEnv('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`,
    // Path-style keeps presigned URLs on the account host
    // (https://<account>.r2.cloudflarestorage.com/<bucket>/<key>).
    forcePathStyle: true,
    credentials: {
      accessKeyId: requiredEnv('R2_ACCESS_KEY_ID'),
      secretAccessKey: requiredEnv('R2_SECRET_ACCESS_KEY'),
    },
  });
  return client;
};

export const getR2Bucket = () => requiredEnv('R2_BUCKET_NAME');

export const orderPrefix = (orderId: string) => `${R2_PREFIX}${orderId}/`;

export const toObjectKey = (orderId: string, key: string) => `${orderPrefix(orderId)}${key}`;

export const getSignedUrlTtlSeconds = () => {
  const raw = Number(process.env.R2_SIGNED_URL_TTL_SECONDS);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_SIGNED_URL_TTL_SECONDS;
};

// The bucket is private, so the only way a browser can fetch a receipt is
// through a short-lived presigned GET URL. Signing is local (no network call).
export const buildSignedUrl = (orderId: string, key: string) =>
  getSignedUrl(
    getR2Client(),
    new GetObjectCommand({ Bucket: getR2Bucket(), Key: toObjectKey(orderId, key) }),
    { expiresIn: getSignedUrlTtlSeconds() }
  );
