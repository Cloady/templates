import { adminQuery } from "../db.ts";
import { env } from "../env.ts";
import { HttpError } from "../http.ts";

function storageEnv() {
  const limit = Number.parseInt(env.vars.UPLOAD_FILE_SIZE_LIMIT || "52428800", 10);
  return {
    fileSizeLimit: Number.isSafeInteger(limit) ? limit : 52428800,
    imageTransformation: env.vars.IMAGE_TRANSFORMATION_ENABLED !== "false",
    s3Protocol: env.vars.S3_PROTOCOL_ENABLED !== "false",
  };
}

async function migrationVersion(): Promise<string | null> {
  try {
    const [row] = await adminQuery<{ name: string }>("select name from storage.migrations order by id desc limit 1");
    return row?.name ?? null;
  } catch {
    return null;
  }
}

export async function storageConfig() {
  const { fileSizeLimit, imageTransformation, s3Protocol } = storageEnv();
  return {
    fileSizeLimit,
    features: {
      imageTransformation: { enabled: imageTransformation },
      s3Protocol: { enabled: s3Protocol },
      purgeCache: { enabled: false },
      icebergCatalog: { enabled: false, maxNamespaces: 0, maxTables: 0, maxCatalogs: 0 },
      vectorBuckets: { enabled: false, maxBuckets: 0, maxIndexes: 0 },
    },
    capabilities: { list_v2: true, iceberg_catalog: false, object_versioning: false },
    external: { upstreamTarget: "main" },
    migrationVersion: await migrationVersion(),
  };
}

export async function storageAttributes() {
  const { fileSizeLimit, imageTransformation, s3Protocol } = storageEnv();
  const migration = await migrationVersion();
  return {
    file_size_limit: fileSizeLimit,
    features: {
      image_transformation: { enabled: imageTransformation },
      s3_protocol: { enabled: s3Protocol },
      iceberg_catalog: { enabled: false, max_namespaces: 0, max_tables: 0, max_catalogs: 0 },
      vector_buckets: { enabled: false, max_buckets: 0, max_indexes: 0 },
    },
    ...(migration === null ? {} : { migration_version: migration }),
  };
}

export function checkStorageUpdate(body: Record<string, unknown>): void {
  const current = storageEnv();
  const features = (body.features ?? {}) as { imageTransformation?: { enabled?: unknown }; s3Protocol?: { enabled?: unknown } };
  const changed = [
    ["UPLOAD_FILE_SIZE_LIMIT", body.fileSizeLimit, current.fileSizeLimit],
    ["IMAGE_TRANSFORMATION_ENABLED", features.imageTransformation?.enabled, current.imageTransformation],
    ["S3_PROTOCOL_ENABLED", features.s3Protocol?.enabled, current.s3Protocol],
  ].filter(([, wanted, now]) => wanted !== undefined && wanted !== now);
  if (changed.length > 0) {
    const settings = changed.map(([name, wanted]) => `${name}=${wanted}`).join(", ");
    throw new HttpError(400, `Storage settings are app variables on self-hosted Supabase: set ${settings}, then restart the storage service.`);
  }
}
