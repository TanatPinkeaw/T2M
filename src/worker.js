import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { claimNextJob, completeJob, getJob, updateJob } from './db.js';

const YTDLP = process.env.YTDLP_PATH ?? 'yt-dlp';
const FFMPEG_DIR = process.env.FFMPEG_PATH ?? '';
// Nothing is kept: every file lives under TMP_DIR and is deleted as soon as it
// has been downloaded (or when FILE_TTL_MIN runs out).
const TMP_DIR = path.resolve(process.env.TMP_DIR ?? './tmp');
const FILE_TTL_MIN = Math.max(0.02, Number(process.env.FILE_TTL_MIN ?? 15));
const MAX_HEIGHT = new Set(['2160', '1440', '1080', '720', '480', '360']);

// yt-dlp needs an external JS runtime to solve YouTube's signature challenges.
// Node 22+ can do the job and it is already present wherever this app runs —
// but very old yt-dlp builds don't know the flag, so only pass it when supported.
const NODE_JS_RUNTIME = Number(process.versions.node.split('.')[0]) >= 22;
let jsRuntimeSupported;

function useNodeRuntime() {
  if (jsRuntimeSupported === undefined) {
    jsRuntimeSupported = false;
    if (NODE_JS_RUNTIME) {
      const help = spawnSync(YTDLP, ['--help'], { encoding: 'utf8', windowsHide: true });
      jsRuntimeSupported = `${help.stdout ?? ''}${help.stderr ?? ''}`.includes('--js-runtimes');
    }
  }
  return jsRuntimeSupported;
}

export const jobDir = (id) => path.join(TMP_DIR, id);

/** Build the yt-dlp arguments for one job. Audio → MP3, video → MP4. */
export function buildArgs(job) {
  const out = path.join(jobDir(job.id), '%(title).120B.%(ext)s');
  const args = [
    '--no-playlist',
    '--no-color',
    '--newline',
    '--no-mtime',
    '--write-info-json',
    '--retries', '3',
    '--fragment-retries', '10',
    '--concurrent-fragments', '4',
    '-o', out,
  ];
  if (FFMPEG_DIR) args.push('--ffmpeg-location', FFMPEG_DIR);
  if (useNodeRuntime()) args.push('--js-runtimes', 'node');
  // Optional: a cookies.txt exported from a logged-in browser beats YouTube's
  // "Sign in to confirm you're not a bot" blocks on server IPs.
  if (process.env.YTDLP_COOKIES) args.push('--cookies', process.env.YTDLP_COOKIES);

  if (job.format === 'mp3') {
    args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
  } else {
    const h = MAX_HEIGHT.has(job.quality) ? job.quality : '1080';
    args.push(
      '-f',
      `bv*[ext=mp4][height<=${h}]+ba[ext=m4a]/b[ext=mp4][height<=${h}]/b[height<=${h}]/b`,
      '--merge-output-format', 'mp4',
    );
  }
  args.push('--', job.url);
  return args;
}

function run(args, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP, args, { windowsHide: true });
    let stderr = '';
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) onLine(line);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    child.on('error', (err) => reject(Object.assign(err, { hint: 'yt-dlp not found' })));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(lastMeaningful(stderr) || `yt-dlp exited with code ${code}`));
    });
  });
}

function lastMeaningful(stderr) {
  const lines = stderr
    .split(/\r?\n/)
    .filter((l) => !/^\s*WARNING:/i.test(l)) // keep the message useful, drop hints
    .map((l) => l.replace(/^\s*ERROR:\s*/i, '').trim())
    .filter(Boolean);
  return lines.slice(-3).join(' · ');
}

const PROGRESS = /^\[download\]\s+(\d+(?:\.\d+)?)%/;
const POSTPROCESS = /^\[(ExtractAudio|Merger|VideoConvertor|FixupM3u8)\]/;

async function processJob(job) {
  const dir = jobDir(job.id);
  await mkdir(dir, { recursive: true });

  let lastPct = 2;
  let lastWrite = 0;

  const onLine = (line) => {
    const m = PROGRESS.exec(line);
    if (m) {
      // download is the first ~95%, encoding/merging the last 5%
      lastPct = Math.min(95, Math.max(lastPct, Math.round(Number(m[1]) * 0.95)));
      const now = Date.now();
      if (now - lastWrite > 700) {
        lastWrite = now;
        updateJob(job.id, { progress: lastPct }).catch(() => {});
      }
    } else if (POSTPROCESS.test(line)) {
      lastPct = 96;
      updateJob(job.id, { progress: lastPct }).catch(() => {});
    }
  };

  await run(buildArgs(job), onLine);

  const files = await readdir(dir);
  const media = [];
  for (const name of files) {
    if (name.endsWith('.info.json') || name.endsWith('.part') || name.endsWith('.ytdl')) continue;
    const full = path.join(dir, name);
    const st = await stat(full);
    if (st.isFile()) media.push({ full, size: Number(st.size) });
  }
  if (media.length === 0) throw new Error('yt-dlp finished but produced no media file');

  media.sort((a, b) => b.size - a.size);
  const file = media[0];

  // Metadata comes free from --write-info-json, no extra request needed.
  let title = path.parse(file.full).name;
  let duration = null;
  let thumbnail = null;
  const infoName = files.find((n) => n.endsWith('.info.json'));
  if (infoName) {
    try {
      const info = JSON.parse(await readFile(path.join(dir, infoName), 'utf8'));
      title = info.title ?? title;
      duration = Number.isFinite(info.duration) ? Math.round(info.duration) : null;
      thumbnail = info.thumbnail ?? null;
    } catch {
      /* metadata is a nicety, not a requirement */
    }
  }

  await completeJob(job.id, {
    title,
    duration,
    thumbnail,
    fileName: path.basename(file.full),
    fileSize: file.size,
    ttlSeconds: FILE_TTL_MIN * 60,
  });
}

export function startWorker({ intervalMs = 1500 } = {}) {
  let running = false;
  let stopped = false;

  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const job = await claimNextJob();
      if (job) {
        try {
          await processJob(job);
        } catch (err) {
          const fresh = await getJob(job.id).catch(() => null);
          // Deleted while it was running → just drop the leftovers.
          if (fresh) {
            await updateJob(job.id, {
              status: 'error',
              progress: 0,
              error: String(err.message ?? err).slice(0, 500),
            });
          }
          await rm(jobDir(job.id), { recursive: true, force: true }).catch(() => {});
        }
      }
    } catch (err) {
      console.error('[worker]', err.message ?? err);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  tick();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export { TMP_DIR };
