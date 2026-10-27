import pg from 'pg';

/**
 * Two drivers behind one tiny interface:
 *  - "pg"     → a real PostgreSQL server (Docker, HomeLab)
 *  - "pglite" → embedded Postgres in WASM, so you can run the app on a laptop
 *               without installing Postgres. Same SQL, same behaviour.
 */
let driver = null;

export async function initDb() {
  if (driver) return driver;
  driver = await createDriver();
  await migrate();
  return driver;
}

async function createDriver() {
  if ((process.env.DB_DRIVER ?? 'pg') === 'pglite') {
    const { PGlite } = await import('@electric-sql/pglite');
    const db = new PGlite(process.env.PGLITE_DIR ?? './.pglite');
    await db.waitReady;
    return {
      query: (text, params) => db.query(text, params),
      close: () => db.close(),
    };
  }

  const pool = new pg.Pool({
    connectionString:
      process.env.DATABASE_URL ?? 'postgres://tube2media:tube2media@localhost:5432/tube2media',
    max: 5,
  });
  return {
    query: (text, params) => pool.query(text, params),
    close: () => pool.end(),
  };
}

async function migrate() {
  await q(`
    CREATE TABLE IF NOT EXISTS jobs (
      id          uuid PRIMARY KEY,
      url         text        NOT NULL,
      format      text        NOT NULL CHECK (format IN ('mp3', 'mp4')),
      quality     text        NOT NULL DEFAULT '1080',
      status      text        NOT NULL DEFAULT 'queued'
                              CHECK (status IN ('queued', 'processing', 'done', 'error')),
      progress    integer     NOT NULL DEFAULT 0,
      title       text,
      duration    integer,
      thumbnail   text,
      file_size   bigint,
      error       text,
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now()
    );
  `);
  // Files are transient now: the name lives in the row, the path is derived
  // from the job id, and `expires_at` is NULL once the file is gone.
  await q(`
    ALTER TABLE jobs
      ADD COLUMN IF NOT EXISTS file_name    text,
      ADD COLUMN IF NOT EXISTS expires_at   timestamptz,
      ADD COLUMN IF NOT EXISTS delivered_at timestamptz;
  `);
  await q(`CREATE INDEX IF NOT EXISTS jobs_queue_idx ON jobs (status, created_at);`);
  await q(`CREATE INDEX IF NOT EXISTS jobs_expiry_idx ON jobs (expires_at) WHERE expires_at IS NOT NULL;`);
}

export function q(text, params) {
  if (!driver) throw new Error('initDb() must be awaited once before querying');
  return driver.query(text, params);
}

export const COLUMNS = `id, url, format, quality, status, progress, title, duration,
  thumbnail, file_size AS "fileSize", error, expires_at AS "expiresAt",
  delivered_at AS "deliveredAt", created_at AS "createdAt"`;

export async function createJob({ id, url, format, quality }) {
  const { rows } = await q(
    `INSERT INTO jobs (id, url, format, quality) VALUES ($1, $2, $3, $4) RETURNING ${COLUMNS}`,
    [id, url, format, quality],
  );
  return rows[0];
}

export async function listJobs(limit = 100) {
  const { rows } = await q(
    `SELECT ${COLUMNS} FROM jobs ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return rows;
}

export async function getJob(id) {
  const { rows } = await q(`SELECT ${COLUMNS}, file_name FROM jobs WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

/** Atomically take the oldest queued job. Safe with several workers running. */
export async function claimNextJob() {
  const { rows } = await q(`
    UPDATE jobs
       SET status = 'processing', progress = 0, error = NULL, updated_at = now()
     WHERE id = (
             SELECT id FROM jobs
              WHERE status = 'queued'
              ORDER BY created_at
                FOR UPDATE SKIP LOCKED
              LIMIT 1
           )
    RETURNING ${COLUMNS}
  `);
  return rows[0] ?? null;
}

export async function updateJob(id, fields) {
  const allowed = ['status', 'progress', 'title', 'duration', 'thumbnail', 'file_name', 'file_size', 'error'];
  const keys = Object.keys(fields).filter((k) => allowed.includes(k));
  if (keys.length === 0) return;
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  await q(`UPDATE jobs SET ${sets}, updated_at = now() WHERE id = $1`, [
    id,
    ...keys.map((k) => fields[k]),
  ]);
}

/** Job finished: the file is only guaranteed to live for `ttlSeconds`. */
export async function completeJob(id, { title, duration, thumbnail, fileName, fileSize, ttlSeconds }) {
  await q(
    `UPDATE jobs
        SET status = 'done', progress = 100, error = NULL,
            title = $2, duration = $3, thumbnail = $4,
            file_name = $5, file_size = $6,
            expires_at = now() + make_interval(secs => $7),
            updated_at = now()
      WHERE id = $1`,
    [id, title, duration, thumbnail, fileName, fileSize, ttlSeconds],
  );
}

/** The file was handed to the user and deleted. */
export async function markDelivered(id) {
  await q(
    `UPDATE jobs SET delivered_at = now(), expires_at = NULL, updated_at = now() WHERE id = $1`,
    [id],
  );
}

/** The file hit its TTL (or never made it to disk) and was deleted. */
export async function markExpired(id) {
  await q(`UPDATE jobs SET expires_at = NULL, updated_at = now() WHERE id = $1`, [id]);
}

/** Every temp file died with the previous process — mark the rows accordingly. */
export async function clearExpiredFiles() {
  await q(`UPDATE jobs SET expires_at = NULL, updated_at = now() WHERE expires_at IS NOT NULL`);
}

/** Jobs whose temp file is past its TTL and can be swept. */
export async function expiredFileJobs() {
  const { rows } = await q(
    `SELECT id FROM jobs
      WHERE status IN ('done', 'error')
        AND expires_at IS NOT NULL
        AND expires_at < now()`,
  );
  return rows.map((r) => r.id);
}

export async function removeJob(id) {
  await q(`DELETE FROM jobs WHERE id = $1`, [id]);
}

/** A worker that died mid-job leaves rows stuck in 'processing'. Put them back. */
export async function requeueStaleJobs() {
  const { rows } = await q(
    `UPDATE jobs SET status = 'queued', progress = 0, updated_at = now()
      WHERE status = 'processing' RETURNING id`,
  );
  return rows.length;
}
