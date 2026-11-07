/**
 * R2 access (spec §3).
 *
 * Two access paths, kept deliberately separate:
 *  - Presigned URLs (S3-compatible SigV4 signing) are the ONLY thing the
 *    browser ever receives. They are short-lived and scoped to one object.
 *  - Direct object operations use the R2 bucket binding, which requires no
 *    credentials at all and is unreachable from the internet.
 *
 * Credentials (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`)
 * are read from Worker secrets and never leave this process.
 */
import { S3Client, HeadObjectCommand, PutObjectCommand, GetObjectCommand, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ApiError, Errors, toApiError } from "./errors";
import { KeySpec } from "./keys";
import type { Env } from "./env";

export type VerifiedObject = {
  objectKey: string;
  size: number;
  etag: string | null;
  contentType: string | null;
};

function s3Endpoint(accountId: string): string {
  return `https://${accountId}.r2.cloudflarestorage.com`;
}

function client(env: Env): S3Client {
  const accountId = env.R2_ACCOUNT_ID;
  const accessKeyId = env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw Errors.misconfigured("R2 credentials are not configured as Worker secrets.");
  }
  return new S3Client({
    region: "auto",
    endpoint: s3Endpoint(accountId),
    credentials: { accessKeyId, secretAccessKey },
  });
}

function bucketName(env: Env): string {
  const name = env.R2_BUCKET_NAME;
  if (!name) throw Errors.misconfigured("The R2 bucket name is not configured.");
  return name;
}

function ttl(env: Env, key: "PUT_URL_TTL_SECONDS" | "GET_URL_TTL_SECONDS", fallback: number): number {
  const parsed = Number.parseInt(env[key] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 3600 ? parsed : fallback;
}

/** Short-lived presigned PUT URL for a freshly created object key. */
export async function presignPut(env: Env, spec: KeySpec, contentType: string): Promise<{ url: string; expiresIn: number }> {
  const expiresIn = ttl(env, "PUT_URL_TTL_SECONDS", 120);
  try {
    const url = await getSignedUrl(
      client(env),
      new PutObjectCommand({
        Bucket: bucketName(env),
        Key: spec.objectKey,
        ContentType: contentType,
        // R2/S3 default to unsigned payloads; content-length is enforced by
        // the object and re-checked by the /complete verification step.
      }),
      { expiresIn, signingDate: new Date() },
    );
    return { url, expiresIn };
  } catch (error) {
    throw toApiError(error);
  }
}

/** Short-lived presigned GET URL for an object the caller is authorized to read. */
export async function presignGet(env: Env, spec: KeySpec): Promise<{ url: string; expiresIn: number }> {
  const expiresIn = ttl(env, "GET_URL_TTL_SECONDS", 300);
  try {
    const url = await getSignedUrl(
      client(env),
      new GetObjectCommand({ Bucket: bucketName(env), Key: spec.objectKey }),
      { expiresIn, signingDate: new Date() },
    );
    return { url, expiresIn };
  } catch (error) {
    throw toApiError(error);
  }
}

/**
 * Verification step: confirms the upload actually landed and that the stored
 * object matches what the server authorized. Presigned URLs expiring, or a
 * client simply never PUTting, must never mark an upload complete.
 * Any object failing verification is immediately deleted so corrupt or mismatched
 * uploads do not linger in R2 storage.
 */
export async function verifyObject(env: Env, spec: KeySpec, expectedSize: number, expectedContentType: string): Promise<VerifiedObject> {
  let head: R2Object | null;
  try {
    head = await env.R2_BUCKET.head(spec.objectKey);
  } catch {
    throw Errors.server("The cloud object could not be inspected.");
  }
  if (!head) {
    throw Errors.uploadUnverified("The upload has not arrived. The presigned URL may have expired before the file was sent.");
  }
  if (head.size !== expectedSize) {
    try {
      await env.R2_BUCKET.delete(spec.objectKey);
    } catch {
      // Best-effort cleanup of rejected object
    }
    throw Errors.verificationFailed(
      `The uploaded object is ${head.size} bytes but the request described ${expectedSize} bytes. The upload was rejected.`,
    );
  }
  const contentType = head.httpMetadata?.contentType ?? null;
  if (!contentType || contentType !== expectedContentType) {
    try {
      await env.R2_BUCKET.delete(spec.objectKey);
    } catch {
      // Best-effort cleanup of rejected object
    }
    throw Errors.verificationFailed(
      `The uploaded object is “${contentType ?? "missing"}” but the request described “${expectedContentType}”. The upload was rejected.`,
    );
  }
  return { objectKey: spec.objectKey, size: head.size, etag: head.etag ?? null, contentType };
}

/** Existence check used before issuing a playback URL. */
export async function objectExists(env: Env, spec: KeySpec): Promise<boolean> {
  try {
    return (await env.R2_BUCKET.head(spec.objectKey)) !== null;
  } catch {
    throw Errors.server("The cloud object could not be inspected.");
  }
}

export type DeletedObjects = { objectKey: string; etag: string | null; kind: KeySpec["kind"] }[];

/**
 * Removes the object plus every sibling belonging to the same track (e.g.
 * its artwork). Every deletion is reported back so the client can audit it.
 * Cloud metadata rows live in Postgres and are removed by the client through
 * RLS-scoped deletes.
 *
 * Guarantees:
 *  - Handles paginated listings across arbitrarily many sibling objects.
 *  - Collects and reports every deletion failure.
 *  - Verifies that zero objects remain under the user's track prefix before
 *    reporting complete success.
 *  - Preserves user-prefix validation (never deletes another user's object).
 *  - Idempotent on retry (succeeds with empty deletion list if already gone).
 */
export async function deleteTrackObjects(env: Env, spec: KeySpec): Promise<DeletedObjects> {
  const deleted: DeletedObjects = [];
  const failedKeys: { key: string; error: string }[] = [];

  try {
    let cursor: string | undefined = undefined;
    const keysToDelete: { key: string; kind: KeySpec["kind"] }[] = [];

    // 1. Paginated listing of all objects under trackPrefix
    do {
      const listed = await env.R2_BUCKET.list({
        prefix: spec.trackPrefix,
        limit: 100,
        cursor,
      });

      for (const object of listed.objects) {
        if (!object.key.startsWith(spec.trackPrefix)) continue;
        const parsed = safeParse(object.key, spec.userId);
        const kind: KeySpec["kind"] = parsed?.kind ?? (object.key.includes("artwork") ? "artwork" : "audio");
        keysToDelete.push({ key: object.key, kind });
      }

      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);

    // 2. Perform deletions and collect any failures
    for (const item of keysToDelete) {
      try {
        await env.R2_BUCKET.delete(item.key);
        deleted.push({ objectKey: item.key, etag: null, kind: item.kind });
      } catch (err) {
        failedKeys.push({ key: item.key, error: err instanceof Error ? err.message : String(err) });
      }
    }

    // 3. Post-deletion verification check
    const remaining = await env.R2_BUCKET.list({ prefix: spec.trackPrefix, limit: 1 });
    if (remaining.objects.length > 0 || failedKeys.length > 0) {
      const details = failedKeys.length > 0
        ? ` (${failedKeys.length} failed: ${failedKeys.map((f) => f.key).join(", ")})`
        : "";
      throw Errors.server(`Cloud objects could not be fully removed${details}.`);
    }

    return deleted;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw Errors.server("The cloud object could not be deleted.");
  }
}

function safeParse(objectKey: string, userId: string): KeySpec | null {
  try {
    return KeySpec.parseAndAuthorize(objectKey, userId);
  } catch {
    return null;
  }
}

/** Test-only helper: signs a HeadObject so verification logic can be probed. */
export async function presignHead(env: Env, spec: KeySpec): Promise<string> {
  return getSignedUrl(client(env), new HeadObjectCommand({ Bucket: bucketName(env), Key: spec.objectKey }), { expiresIn: 30 });
}

/** Test-only helper: exercises the S3 multi-object delete path. */
export async function deleteObjects(env: Env, keys: string[]): Promise<void> {
  const command = new DeleteObjectsCommand({
    Bucket: bucketName(env),
    Delete: { Objects: keys.map((key) => ({ Key: key })) },
  });
  await client(env).send(command);
}
