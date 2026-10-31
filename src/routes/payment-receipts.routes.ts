import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import type { AuthVariables } from '../middlewares/auth.middleware';
import { ORDER_ID_PATTERN } from '../middlewares/require-order-access.middleware';
import {
  getR2Client,
  getR2Bucket,
  toObjectKey,
  orderPrefix,
  buildSignedUrl,
  getSignedUrlTtlSeconds,
} from '../config/r2';
import {
  validateImage,
  generateImageKey,
  MAX_FILE_SIZE_BYTES,
} from '../utils/image-validation.utils';

type AuthContext = Context<{ Variables: AuthVariables }>;

const ErrorSchema = z.object({
  success: z.literal(false),
  error: z.string(),
  message: z.string().optional(),
});

const ReceiptBaseSchema = z.object({
  key: z.string(),
  orderId: z.string(),
  url: z.string().openapi({ description: 'Presigned GET URL - the bucket is private' }),
  expiresIn: z.number().openapi({ description: 'Seconds until url stops working' }),
  size: z.number(),
});

const UploadedReceiptSchema = ReceiptBaseSchema.extend({
  contentType: z.string(),
  width: z.number(),
  height: z.number(),
});

const ListedReceiptSchema = ReceiptBaseSchema.extend({
  lastModified: z.string(),
});

const StoredReceiptSchema = ListedReceiptSchema.extend({
  contentType: z.string(),
  uploadedBy: z.number().nullable(),
  originalName: z.string().nullable(),
});

const UploadResponseSchema = z.object({ success: z.literal(true), data: UploadedReceiptSchema });
const ListResponseSchema = z.object({ success: z.literal(true), data: z.array(ListedReceiptSchema) });
const DetailResponseSchema = z.object({ success: z.literal(true), data: StoredReceiptSchema });
const DeleteResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({ key: z.string(), orderId: z.string() }),
});

const orderIdSchema = z
  .string()
  .regex(ORDER_ID_PATTERN, 'orderId must be a positive integer')
  .openapi({ description: 'purchase_orders.id_purchase_order', example: '123' });

const OrderParamSchema = z.object({ orderId: orderIdSchema });

const ReceiptParamSchema = z.object({
  orderId: orderIdSchema,
  key: z.string().uuid('key must be a receipt id (UUID)'),
});

const FileBodySchema = z.object({
  file: z.any().openapi({ type: 'string', format: 'binary' }),
});

const json = (schema: z.ZodTypeAny) => ({ 'application/json': { schema } });

const errorResponses = {
  400: { description: 'Bad request', content: json(ErrorSchema) },
  401: { description: 'Unauthorized', content: json(ErrorSchema) },
  500: { description: 'Internal server error', content: json(ErrorSchema) },
};

const notFoundResponse = { 404: { description: 'Not found', content: json(ErrorSchema) } };

const routeDefaults = { tags: ['Payment receipts'], security: [{ Bearer: [] }] };

const badRequest = (c: Context, message: string) =>
  c.json({ success: false, error: 'Bad Request', message }, 400);

const notFound = (c: Context) =>
  c.json({ success: false, error: 'Not Found', message: 'Payment receipt not found' }, 404);

const isNotFoundError = (err: unknown) =>
  err instanceof Error && ['NotFound', 'NoSuchKey'].includes(err.name);

// S3 user metadata must be ASCII, so the original filename is URI-encoded.
const encodeName = (name: string) => encodeURIComponent(name).slice(0, 512);
const decodeName = (value: string | undefined) => {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

type ParsedUpload =
  | { ok: true; buffer: Buffer; file: File; width: number; height: number }
  | { ok: false; response: Response };

const parseUpload = async (c: Context): Promise<ParsedUpload> => {
  const declaredSize = Number(c.req.header('content-length'));
  if (declaredSize > MAX_FILE_SIZE_BYTES) {
    return { ok: false, response: badRequest(c, `File must be at most ${MAX_FILE_SIZE_BYTES} bytes`) };
  }

  const body = await c.req.parseBody();
  const file = body['file'];
  if (!(file instanceof File)) {
    return { ok: false, response: badRequest(c, 'file is required') };
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const result = validateImage(buffer, file.type);
  if (result.ok === false) {
    return { ok: false, response: badRequest(c, result.message) };
  }

  return { ok: true, buffer, file, width: result.width, height: result.height };
};

const putReceipt = async (c: AuthContext, orderId: string, key: string, upload: ParsedUpload & { ok: true }) => {
  await getR2Client().send(
    new PutObjectCommand({
      Bucket: getR2Bucket(),
      Key: toObjectKey(orderId, key),
      Body: upload.buffer,
      ContentType: upload.file.type,
      Metadata: {
        'uploaded-by': String(c.get('id_user')),
        'original-name': encodeName(upload.file.name),
      },
    })
  );

  return {
    key,
    orderId,
    url: await buildSignedUrl(orderId, key),
    expiresIn: getSignedUrlTtlSeconds(),
    contentType: upload.file.type,
    size: upload.buffer.byteLength,
    width: upload.width,
    height: upload.height,
  };
};

// Returns the HeadObject output, or null when the receipt does not exist.
const headReceipt = async (orderId: string, key: string) => {
  try {
    return await getR2Client().send(
      new HeadObjectCommand({ Bucket: getR2Bucket(), Key: toObjectKey(orderId, key) })
    );
  } catch (err) {
    if (isNotFoundError(err)) return null;
    throw err;
  }
};

export const registerPaymentReceiptsRoutes = (apiV1: any) => {
  const collectionPath = '/purchase-orders/{orderId}/payments';
  const itemPath = '/purchase-orders/{orderId}/payments/{key}';
  const fileBody = { body: { content: { 'multipart/form-data': { schema: FileBodySchema } } } };

  const uploadRoute = createRoute({
    method: 'post',
    path: collectionPath,
    summary: 'Upload a payment receipt image for a purchase order',
    request: { params: OrderParamSchema, ...fileBody },
    responses: { 201: { description: 'Uploaded', content: json(UploadResponseSchema) }, ...errorResponses },
    ...routeDefaults,
  });

  const listRoute = createRoute({
    method: 'get',
    path: collectionPath,
    summary: 'List the payment receipts of a purchase order',
    request: { params: OrderParamSchema },
    responses: { 200: { description: 'Receipts', content: json(ListResponseSchema) }, ...errorResponses },
    ...routeDefaults,
  });

  const getRoute = createRoute({
    method: 'get',
    path: itemPath,
    summary: 'Get one payment receipt with a fresh signed URL',
    request: { params: ReceiptParamSchema },
    responses: {
      200: { description: 'Receipt detail', content: json(DetailResponseSchema) },
      ...notFoundResponse,
      ...errorResponses,
    },
    ...routeDefaults,
  });

  const replaceRoute = createRoute({
    method: 'put',
    path: itemPath,
    summary: 'Replace the image of an existing payment receipt',
    request: { params: ReceiptParamSchema, ...fileBody },
    responses: {
      200: { description: 'Replaced', content: json(UploadResponseSchema) },
      ...notFoundResponse,
      ...errorResponses,
    },
    ...routeDefaults,
  });

  const deleteRoute = createRoute({
    method: 'delete',
    path: itemPath,
    summary: 'Delete a payment receipt',
    request: { params: ReceiptParamSchema },
    responses: {
      200: { description: 'Deleted', content: json(DeleteResponseSchema) },
      ...notFoundResponse,
      ...errorResponses,
    },
    ...routeDefaults,
  });

  // Caller is responsible for applying requireAuth() to '/purchase-orders/*'
  // before this registration - kept out of this function so route wiring
  // stays testable with a stand-in auth context.
  apiV1.openapi(uploadRoute, async (c: AuthContext) => {
    const orderId = c.req.param('orderId');
    const upload = await parseUpload(c);
    if (upload.ok === false) return upload.response;

    const data = await putReceipt(c, orderId, generateImageKey(), upload);
    return c.json({ success: true, data }, 201);
  });

  apiV1.openapi(listRoute, async (c: AuthContext) => {
    const orderId = c.req.param('orderId');
    const prefix = orderPrefix(orderId);
    const client = getR2Client();

    const objects: { Key?: string; Size?: number; LastModified?: Date }[] = [];
    let continuationToken: string | undefined;
    do {
      const page = await client.send(
        new ListObjectsV2Command({
          Bucket: getR2Bucket(),
          Prefix: prefix,
          ContinuationToken: continuationToken,
        })
      );
      objects.push(...(page.Contents ?? []));
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);

    const expiresIn = getSignedUrlTtlSeconds();
    const data = await Promise.all(
      objects
        .filter((o) => o.Key && o.Key.length > prefix.length)
        .sort((a, b) => (a.LastModified?.getTime() ?? 0) - (b.LastModified?.getTime() ?? 0))
        .map(async (o) => {
          const key = o.Key!.slice(prefix.length);
          return {
            key,
            orderId,
            url: await buildSignedUrl(orderId, key),
            expiresIn,
            size: o.Size ?? 0,
            lastModified: (o.LastModified ?? new Date()).toISOString(),
          };
        })
    );

    return c.json({ success: true, data }, 200);
  });

  apiV1.openapi(getRoute, async (c: AuthContext) => {
    const orderId = c.req.param('orderId');
    const key = c.req.param('key');
    const head = await headReceipt(orderId, key);
    if (!head) return notFound(c);

    const uploadedBy = Number(head.Metadata?.['uploaded-by']);
    return c.json(
      {
        success: true,
        data: {
          key,
          orderId,
          url: await buildSignedUrl(orderId, key),
          expiresIn: getSignedUrlTtlSeconds(),
          contentType: head.ContentType ?? 'application/octet-stream',
          size: head.ContentLength ?? 0,
          lastModified: (head.LastModified ?? new Date()).toISOString(),
          uploadedBy: Number.isFinite(uploadedBy) ? uploadedBy : null,
          originalName: decodeName(head.Metadata?.['original-name']),
        },
      },
      200
    );
  });

  apiV1.openapi(replaceRoute, async (c: AuthContext) => {
    const orderId = c.req.param('orderId');
    const key = c.req.param('key');
    if (!(await headReceipt(orderId, key))) return notFound(c);

    const upload = await parseUpload(c);
    if (upload.ok === false) return upload.response;

    const data = await putReceipt(c, orderId, key, upload);
    return c.json({ success: true, data }, 200);
  });

  apiV1.openapi(deleteRoute, async (c: AuthContext) => {
    const orderId = c.req.param('orderId');
    const key = c.req.param('key');
    if (!(await headReceipt(orderId, key))) return notFound(c);

    await getR2Client().send(
      new DeleteObjectCommand({ Bucket: getR2Bucket(), Key: toObjectKey(orderId, key) })
    );
    return c.json({ success: true, data: { key, orderId } }, 200);
  });
};
