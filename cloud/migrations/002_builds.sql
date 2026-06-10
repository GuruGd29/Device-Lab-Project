-- Build library + install jobs. A build is a platform package uploaded once into a shared
-- library; an install job tracks pushing one build onto one TV.

CREATE TABLE IF NOT EXISTS builds (
  build_id       TEXT PRIMARY KEY,
  filename       TEXT NOT NULL,
  platform       TEXT NOT NULL CHECK (platform IN ('tizen', 'webos', 'androidtv')),
  package_kind   TEXT NOT NULL CHECK (package_kind IN ('apk', 'wgt', 'ipk')),
  size_bytes     BIGINT NOT NULL,
  storage_path   TEXT NOT NULL,          -- where the cloud stored the bytes (server-local/object store)
  app_id         TEXT,                   -- package/app id, used to launch after install
  uploaded_by    TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS install_jobs (
  job_id         TEXT PRIMARY KEY,
  tv_id          TEXT NOT NULL REFERENCES tvs(tv_id) ON DELETE CASCADE,
  build_id       TEXT NOT NULL REFERENCES builds(build_id) ON DELETE CASCADE,
  status         TEXT NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued', 'downloading', 'installing', 'installed', 'failed')),
  progress       REAL NOT NULL DEFAULT 0,
  message        TEXT,
  requested_by   TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_builds_platform ON builds (platform);
CREATE INDEX IF NOT EXISTS idx_install_jobs_tv ON install_jobs (tv_id, created_at DESC);
