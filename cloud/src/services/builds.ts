// Build library — stores uploaded platform packages (apk/wgt/ipk) and serves them to the lab
// agent for install. The cloud is fine carrying a build (it's a one-shot artifact, not media);
// the agent downloads it over HTTP authenticated by the agent shared secret.
import { mkdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  Build,
  PackageKind,
  Platform,
} from "@device-lab/contracts";
import { PACKAGE_TO_PLATFORM } from "@device-lab/contracts";
import type { DbPool } from "../db.js";
import { iso } from "../db.js";
import type { Config } from "../config.js";

interface BuildRow {
  build_id: string;
  filename: string;
  platform: Platform;
  package_kind: PackageKind;
  size_bytes: string | number;
  storage_path: string;
  app_id: string | null;
  uploaded_by: string | null;
  created_at: Date;
}

const EXT_TO_KIND: Record<string, PackageKind> = {
  apk: "apk",
  wgt: "wgt",
  ipk: "ipk",
};

export function packageKindFromFilename(filename: string): PackageKind | null {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return EXT_TO_KIND[ext] ?? null;
}

export class BuildsService {
  constructor(
    private readonly pool: DbPool,
    private readonly config: Config,
  ) {}

  async ensureUploadsDir(): Promise<void> {
    await mkdir(resolve(this.config.uploadsDir), { recursive: true });
  }

  /** Absolute path the route streams the upload into, before recording it. */
  storagePathFor(buildId: string, kind: PackageKind): string {
    return join(resolve(this.config.uploadsDir), `${buildId}.${kind}`);
  }

  /** Where the agent fetches the bytes from. */
  downloadUrl(buildId: string): string {
    return `${this.config.publicHttpUrl}/builds/${buildId}/download`;
  }

  async record(row: {
    build_id: string;
    filename: string;
    package_kind: PackageKind;
    size_bytes: number;
    storage_path: string;
    app_id: string | null;
    uploaded_by: string | null;
  }): Promise<Build> {
    const platform = PACKAGE_TO_PLATFORM[row.package_kind];
    const res = await this.pool.query<BuildRow>(
      `INSERT INTO builds (build_id, filename, platform, package_kind, size_bytes, storage_path, app_id, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        row.build_id,
        row.filename,
        platform,
        row.package_kind,
        row.size_bytes,
        row.storage_path,
        row.app_id,
        row.uploaded_by,
      ],
    );
    return toBuild(res.rows[0]!);
  }

  async list(platform?: Platform): Promise<Build[]> {
    const res = platform
      ? await this.pool.query<BuildRow>(
          "SELECT * FROM builds WHERE platform = $1 ORDER BY created_at DESC",
          [platform],
        )
      : await this.pool.query<BuildRow>("SELECT * FROM builds ORDER BY created_at DESC");
    return res.rows.map(toBuild);
  }

  async get(buildId: string): Promise<Build | null> {
    const res = await this.pool.query<BuildRow>(
      "SELECT * FROM builds WHERE build_id = $1",
      [buildId],
    );
    return res.rowCount ? toBuild(res.rows[0]!) : null;
  }

  /** Internal: storage path + filename for the download route. */
  async getStorage(
    buildId: string,
  ): Promise<{ storage_path: string; filename: string } | null> {
    const res = await this.pool.query<{ storage_path: string; filename: string }>(
      "SELECT storage_path, filename FROM builds WHERE build_id = $1",
      [buildId],
    );
    return res.rowCount ? res.rows[0]! : null;
  }

  async delete(buildId: string): Promise<boolean> {
    const res = await this.pool.query<{ storage_path: string }>(
      "DELETE FROM builds WHERE build_id = $1 RETURNING storage_path",
      [buildId],
    );
    if (!res.rowCount) return false;
    await unlink(res.rows[0]!.storage_path).catch(() => {}); // best-effort file cleanup
    return true;
  }
}

function toBuild(r: BuildRow): Build {
  return {
    build_id: r.build_id,
    filename: r.filename,
    platform: r.platform,
    package_kind: r.package_kind,
    size_bytes: Number(r.size_bytes),
    app_id: r.app_id,
    uploaded_by: r.uploaded_by,
    created_at: iso(r.created_at)!,
  };
}
