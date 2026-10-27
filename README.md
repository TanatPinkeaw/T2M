# T2M · Tube2Media

Self-hosted video/audio grabber with a **PostgreSQL job queue**: paste a link, pick **MP3** or
**MP4**, download the result — and the server keeps nothing. No external services, no cloud,
no API keys.

**Files are never stored.** The converted file is deleted the moment its download finishes, and
anything nobody downloads expires after `FILE_TTL_MIN` (15 minutes by default).

```
Browser ──POST /api/jobs──▶ Express ──INSERT──▶ Postgres (jobs)
                                │                    │
                                │         claim: FOR UPDATE SKIP LOCKED
                                ▼                    ▼
                         public/ (UI)       worker in the same process
                                                      │
                                        yt-dlp + ffmpeg → /data/tmp/<job id>/
                                                      │  (temporary files only)
                                GET /api/jobs/:id/file ◀── (download → delete)
```

**English** · [ไทย](#ภาษาไทย)

## Getting started

### 1. Docker (home server, NAS, VPS)

```bash
git clone https://github.com/TanatPinkeaw/T2M.git
cd T2M
cp .env.example .env       # set POSTGRES_PASSWORD to something unguessable
docker compose up -d --build
```

Open `http://<your-host>:8080` (change the port with `APP_PORT` in `.env`).

```bash
docker compose logs -f app     # follow logs
docker compose down            # stop (data is kept)
docker compose down -v         # stop and delete everything
```

The image ships ffmpeg, python3 and yt-dlp, so there is nothing else to install. Two named
volumes are used: `pgdata` (database and job history) and `tmp` (temporary files, empty most of
the time). To keep temporary files in RAM instead of on disk, replace the `tmp` volume with the
commented-out `tmpfs:` entry in `docker-compose.yml` — mind the RAM (a 1-hour 1080p clip needs
about 1–2 GB).

### 2. Local development (no Docker, no PostgreSQL)

Needs Node 22+, plus `yt-dlp` and `ffmpeg` on your `PATH`
(`winget install yt-dlp ffmpeg`, `brew install yt-dlp ffmpeg`, or `pip install -U yt-dlp`).

```bash
npm install
DB_DRIVER=pglite TMP_DIR=./tmp npm start
```

`DB_DRIVER=pglite` runs an embedded Postgres (PGlite) inside `./.pglite`, so nothing has to be
installed. To use a real server instead:
`DB_DRIVER=pg DATABASE_URL=postgres://user:pass@host:5432/tube2media npm start`

## Configuration

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `PORT` | `8080` | HTTP port |
| `DATABASE_URL` | – | e.g. `postgres://user:pass@db:5432/tube2media` |
| `DB_DRIVER` | `pg` | `pg` or `pglite` (embedded Postgres) |
| `TMP_DIR` | `./tmp` | Temporary directory for converted files (`/data/tmp` in Docker) |
| `FILE_TTL_MIN` | `15` | Minutes an undownloaded file waits before it is deleted |
| `YTDLP_PATH` | `yt-dlp` | Path to the yt-dlp binary |
| `FFMPEG_PATH` | – | ffmpeg folder, if it is not on `PATH` |
| `YTDLP_COOKIES` | – | Path to a `cookies.txt` for restricted downloads |

## API

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/api/jobs` | 100 most recent jobs |
| POST | `/api/jobs` | `{ "url": "...", "format": "mp3" \| "mp4", "quality": "1080" }` |
| GET | `/api/jobs/:id` | One job's status (used for polling) |
| GET | `/api/jobs/:id/file` | Download the file — `409` if not ready, `410` if expired/deleted |
| DELETE | `/api/jobs/:id` | Delete the job and its file |

## Notes and limits

- **No authentication.** Run it on a LAN or VPN, or behind an authenticating reverse proxy
  (Caddy `basicauth`, Authelia, Cloudflare Access…). Do not expose it to the internet as is.
- Accepts any `http(s)` URL that yt-dlp supports, not just YouTube, and rejects LAN/private
  addresses as a basic SSRF guard.
- One job runs at a time; extra jobs wait in the queue.
- A finished job can be downloaded **once**. Afterwards the file is gone — press "แปลงใหม่"
  (convert again) in the list to recreate it from the same URL, format and quality.
- The web UI loads its fonts from Google Fonts, so the browser needs internet access.
- YouTube changes often: update yt-dlp occasionally (command in the Thai section below). If you
  see "Sign in to confirm you're not a bot", point `YTDLP_COOKIES` at a `cookies.txt` exported
  from a browser where you are signed in.
- Download only content you own or are allowed to grab. Pulling videos from YouTube may conflict
  with the platform's terms of service — keep it personal.

## License

[MIT](LICENSE)

---

## ภาษาไทย

เอกสารฉบับเต็ม (เหมือนเดิมทุกบรรทัด) อยู่ด้านล่างนี้

เว็บแปลงคลิปเป็น **MP3 / MP4** ใช้เองบน HomeLab — คิวงานเก็บใน **PostgreSQL**, ดาวน์โหลด/แปลงด้วย **yt-dlp + ffmpeg**
ไม่มี dependency ภายนอก ไม่มี cloud ไม่มี API key

**ไม่เก็บไฟล์**: แปลงเสร็จ → กดดาวน์โหลด → ไฟล์ถูกลบทันที ไม่มีไฟล์สะสมบนเครื่อง

```
เบราว์เซอร์ ──POST /api/jobs──▶ Express ──INSERT──▶ Postgres (jobs)
                                   │                    │
                                   │           claim: FOR UPDATE SKIP LOCKED
                                   ▼                    ▼
                            public/ (UI)          worker ในโปรเซสเดียวกัน
                                                        │
                                              yt-dlp + ffmpeg → /data/tmp/<job id>/
                                                        │  (ไฟล์ชั่วคราวเท่านั้น)
                                   GET /api/jobs/:id/file ◀── (ดาวน์โหลด → ลบ)
```

- คิวอยู่ใน DB ⇒ รีสตาร์ทแล้วงานไม่หาย (งานที่ค้าง `processing` จะถูกจัดกลับเข้าคิวตอนบูต)
- progress อัปเดตระหว่างดาวน์โหลด, งานเสร็จแล้วกดดาวน์โหลดหรือลบได้จากหน้าเว็บ
- 1 คอนเทนเนอร์ = API + worker (ไม่ต้องมี Redis / ไม่ต้องมี worker แยก / ไม่ต้องมี volume สำหรับไฟล์)
- ชีวิตของไฟล์สั้นมาก: **ลบหลังดาวน์โหลด**, **ลบเมื่อครบ `FILE_TTL_MIN`** (ค่าเริ่มต้น 15 นาที) ถ้าไม่มีคนโหลด,
  **ลบเมื่อกด ✕**, **ลบเมื่อเกิด error**, และ **ลบทั้งหมดตอนบูต** (ไฟล์ของ process ก่อนหน้า)
- กดดาวน์โหลดซ้ำไม่ได้ — ไฟล์ไม่มีแล้ว ให้กด **“แปลงใหม่”** ในรายการ (ใช้ url/format/quality เดิม)

### รันบน HomeLab (Docker)

```bash
cp .env.example .env       # ตั้ง POSTGRES_PASSWORD ให้เดายาก
docker compose up -d --build
```

เปิด `http://<ip-ของโฮมแล็บ>:8080` (เปลี่ยนพอร์ตได้ที่ `APP_PORT` ใน `.env`)

ข้อมูลมี named volume 2 ตัว: `pgdata` (ฐานข้อมูล/ประวัติงาน) และ `tmp` (ไฟล์ชั่วคราว ซึ่งจะว่างเกือบตลอดเวลา)
ถ้าไม่อยากให้ไฟล์แตะดิสก์เลย ให้สลับ `tmp` เป็น `tmpfs` ใน `docker-compose.yml` (ต้องมี RAM พอ: คลิป 1 ชม.@1080p ≈ 1-2 GB)

```bash
docker compose logs -f app        # ดู log
docker compose down               # หยุด (ข้อมูลไม่หาย)
docker compose down -v            # หยุด + ลบข้อมูลทั้งหมด
```

#### ถ้าเจอ "Sign in to confirm you're not a bot"

เซิร์ฟเวอร์/Homelab ที่ใช้ IP ของ datacenter มักโดน YouTube บล็อก ให้ export cookies จากเบราว์เซอร์ที่ล็อกอินอยู่
(ส่วนขยาย "Get cookies.txt LOCALLY") แล้ววางไฟล์ไว้ที่ `./cookies.txt` จากนั้นเพิ่มใน `docker-compose.yml`:

```yaml
    environment:
      YTDLP_COOKIES: /data/cookies.txt
    volumes:
      - ./cookies.txt:/data/cookies.txt:ro
```

#### อัปเดต yt-dlp (YouTube เปลี่ยนบ่อย — ควรอัปเดตเป็นครั้งคราว)

```bash
docker compose exec app pip3 install --break-system-packages -U yt-dlp \
  || docker compose build --pull --no-cache app && docker compose up -d
```

yt-dlp ต้องมี JS runtime สำหรับแก้ signature ของ YouTube — แอปส่ง `--js-runtimes node` ให้อัตโนมัติ
และ Node 22+ ที่อยู่ในอิมเมจทำหน้าที่นั้นอยู่แล้ว จึงไม่ต้องติดตั้ง Deno เพิ่ม

### รันบนเครื่องตัวเอง (ไม่ต้องมี Docker / ไม่ต้องมี Postgres)

ต้องมี `yt-dlp` และ `ffmpeg` ใน `PATH` (เช่น `winget install yt-dlp ffmpeg` หรือ `pip install -U yt-dlp`)

```bash
npm install
DB_DRIVER=pglite TMP_DIR=./tmp npm start   # Postgres แบบ embedded (PGlite) เก็บใน ./.pglite
```

เปิด http://localhost:8080 ถ้าอยากต่อ Postgres ตัวจริงให้ตั้ง `DB_DRIVER=pg` + `DATABASE_URL=...`

### API

| Method | Path                  | ทำอะไร                                            |
| ------ | --------------------- | ------------------------------------------------- |
| GET    | `/api/jobs`           | รายการงานล่าสุด 100 รายการ                        |
| POST   | `/api/jobs`           | `{ "url": "...", "format": "mp3" \| "mp4", "quality": "1080" }` |
| GET    | `/api/jobs/:id`       | สถานะงานเดียว (ใช้ poll)                          |
| GET    | `/api/jobs/:id/file`  | ดาวน์โหลดไฟล์ (409 ถ้ายังไม่เสร็จ, 410 ถ้าหมดอายุ/ถูกลบแล้ว) |
| DELETE | `/api/jobs/:id`       | ลบทั้งงานและไฟล์                                   |

### Environment variables

| ตัวแปร           | ค่าเริ่มต้น                                  | หมายเหตุ                          |
| ---------------- | -------------------------------------------- | --------------------------------- |
| `PORT`           | `8080`                                       | พอร์ตของเว็บ                      |
| `DATABASE_URL`   | –                                            | เช่น `postgres://user:pass@db:5432/tube2media` |
| `DB_DRIVER`      | `pg`                                         | `pg` หรือ `pglite` (embedded)     |
| `TMP_DIR`        | `./tmp`                                      | ที่พักไฟล์ชั่วคราว (`/data/tmp` ใน Docker) |
| `FILE_TTL_MIN`   | `15`                                         | นาทีที่ไฟล์รอให้ดาวน์โหลดก่อนถูกลบ |
| `YTDLP_PATH`     | `yt-dlp`                                     | path ของ yt-dlp                   |
| `FFMPEG_PATH`    | –                                            | โฟลเดอร์ ffmpeg ถ้าไม่อยู่ใน PATH |
| `YTDLP_COOKIES`  | –                                            | path ของ `cookies.txt`            |

### ข้อควรรู้

- **ไม่มีระบบ login** — ใช้ใน LAN/VPN เท่านั้น ถ้าจะเปิดออกอินเทอร์เน็ตให้วางไว้หลัง reverse proxy ที่มี auth (Caddy `basicauth`, Authelia, Cloudflare Access ฯลฯ)
- ลิงก์ที่รับเข้าเป็น http/https และปฏิเสธ IP ในวง LAN (กัน SSRF) — รองรับทุกเว็บที่ yt-dlp รองรับ ไม่ใช่แค่ YouTube
- **ไม่มีไฟล์ค้าง**: หลังดาวน์โหลดจบ (หน่วง 2 วินาทีกันเน็ตช้า) ไฟล์จะถูกลบ, ที่เหลือถูกเก็บกวาดด้วย TTL ทุก 60 วินาที; ประวัติงาน (ชื่อ/ขนาด/สถานะ) ยังอยู่ใน Postgres
- ถ้าอยากเก็บไฟล์ไว้ดูย้อนหลังเป็นครั้งคราว จะต้องเพิ่มธง “เก็บไว้” ต่อ job (ยังไม่ได้ทำในเวอร์ชันนี้)
- worker อยู่ในโปรเซสเดียวกับ API และให้บริการไฟล์จากดิสก์ในเครื่องนั้น ⇒ รัน `app` แค่ 1 อินสแตนซ์ (คิวออกแบบให้หลาย worker ปลอดภัยด้วย `SKIP LOCKED` อยู่แล้ว ถ้าจะแยก worker ในอนาคตต้องใช้ storage ร่วม)
- ดาวน์โหลดเฉพาะเนื้อหาที่คุณมีสิทธิ์หรือได้รับอนุญาต — การดึงวิดีโอจาก YouTube อาจขัดกับข้อกำหนดการใช้งานของแพลตฟอร์ม ใช้ส่วนตัวเท่านั้น
- ไม่อยากดูแลโค้ดเอง? โปรเจกต์สำเร็จรูปที่คล้ายกันคือ [MeTube](https://github.com/alexta69/metube) หรือ [cobalt](https://github.com/imputnet/cobalt) (แต่คิวเป็นไฟล์/ Redis ไม่ใช่ Postgres)
