import { describe, it, expect, beforeEach } from 'vitest';
import {
  getR2Client,
  getR2Bucket,
  toObjectKey,
  orderPrefix,
  buildSignedUrl,
  getSignedUrlTtlSeconds,
  R2_PREFIX,
  DEFAULT_SIGNED_URL_TTL_SECONDS,
} from './r2';

describe('r2 config', () => {
  beforeEach(() => {
    process.env.R2_ACCOUNT_ID = 'test-account';
    process.env.R2_ACCESS_KEY_ID = 'test-key-id';
    process.env.R2_SECRET_ACCESS_KEY = 'test-secret';
    process.env.R2_BUCKET_NAME = 'paymentspurchseordes';
    delete process.env.R2_SIGNED_URL_TTL_SECONDS;
  });

  it('returns the same S3Client instance on repeated calls', () => {
    expect(getR2Client()).toBe(getR2Client());
  });

  it('reads the bucket name from R2_BUCKET_NAME', () => {
    expect(getR2Bucket()).toBe('paymentspurchseordes');
  });

  it('groups object keys by purchase order', () => {
    expect(R2_PREFIX).toBe('purchase-orders/');
    expect(orderPrefix('42')).toBe('purchase-orders/42/');
    expect(toObjectKey('42', 'abc')).toBe('purchase-orders/42/abc');
  });

  it('defaults the signed URL TTL and honours a valid override', () => {
    expect(getSignedUrlTtlSeconds()).toBe(DEFAULT_SIGNED_URL_TTL_SECONDS);
    process.env.R2_SIGNED_URL_TTL_SECONDS = '60';
    expect(getSignedUrlTtlSeconds()).toBe(60);
    process.env.R2_SIGNED_URL_TTL_SECONDS = 'nope';
    expect(getSignedUrlTtlSeconds()).toBe(DEFAULT_SIGNED_URL_TTL_SECONDS);
  });

  it('builds a presigned URL against the private bucket, not a public URL', async () => {
    process.env.R2_SIGNED_URL_TTL_SECONDS = '300';
    const url = new URL(await buildSignedUrl('42', 'abc'));
    expect(url.hostname).toBe('test-account.r2.cloudflarestorage.com');
    expect(url.pathname).toBe('/paymentspurchseordes/purchase-orders/42/abc');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy();
  });
});
