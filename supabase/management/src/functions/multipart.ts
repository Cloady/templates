import { readFile } from "node:fs/promises";
import { HttpError } from "../http.ts";
import { randomAlnum } from "../ids.ts";

export interface SourceMetadata {
  entrypoint_path: string;
  import_map_path?: string | null;
  static_patterns?: string[] | null;
  verify_jwt?: boolean | null;
  name?: string | null;
}

export interface SourceUpload {
  metadata: SourceMetadata;
  files: File[];
}

export interface DownloadFile {
  path: string;
  source: string;
}

const encoder = new TextEncoder();

const optional = (value: unknown, type: string) => value === undefined || value === null || typeof value === type;

function parseMetadata(text: string): SourceMetadata {
  let m: Record<string, unknown> | null = null;
  try {
    m = JSON.parse(text);
  } catch {}
  const patterns = m?.static_patterns;
  const valid =
    typeof m === "object" &&
    m !== null &&
    !Array.isArray(m) &&
    typeof m.entrypoint_path === "string" &&
    m.entrypoint_path !== "" &&
    optional(m.import_map_path, "string") &&
    optional(m.verify_jwt, "boolean") &&
    optional(m.name, "string") &&
    (patterns == null || (Array.isArray(patterns) && patterns.every((p) => typeof p === "string")));
  if (!valid) throw new HttpError(400, "Invalid metadata");
  return m as unknown as SourceMetadata;
}

export async function readSourceUpload(req: Request, maxBytes: number, maxFiles: number): Promise<SourceUpload> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new HttpError(400, "Body must be multipart/form-data");
  }
  const metadata = form.get("metadata");
  const files = form.getAll("file");
  if (metadata === null) throw new HttpError(400, "metadata is required");
  if (files.some((f) => typeof f === "string")) throw new HttpError(400, "Every file part must be a file");
  const uploads = files as File[];
  if (uploads.length > maxFiles) throw new HttpError(413, `An upload may contain at most ${maxFiles} files`);
  if (uploads.reduce((sum, f) => sum + f.size, 0) > maxBytes) {
    throw new HttpError(413, `The upload is larger than ${maxBytes / 1048576} MiB`);
  }
  return { metadata: parseMetadata(typeof metadata === "string" ? metadata : await metadata.text()), files: uploads };
}

async function* parts(boundary: string, metadata: object, files: DownloadFile[]): AsyncGenerator<Uint8Array> {
  yield encoder.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(metadata)}\r\n`,
  );
  for (const file of files) {
    yield encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename*=UTF-8''${encodeURIComponent(file.path)}\r\nSupabase-Path: ${file.path}\r\nContent-Type: application/octet-stream\r\n\r\n`,
    );
    yield await readFile(file.source);
    yield encoder.encode("\r\n");
  }
  yield encoder.encode(`--${boundary}--\r\n`);
}

export function multipartResponse(metadata: object, files: DownloadFile[]): Response {
  const boundary = `----management-${randomAlnum(24)}`;
  const chunks = parts(boundary, metadata, files);
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await chunks.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
  });
  return new Response(body, { headers: { "content-type": `multipart/form-data; boundary=${boundary}` } });
}
