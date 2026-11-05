// 550: объектное хранилище (медиа) — обработчики прежнего `server.js` слоя данных ДОСЛОВНО (вырезка строк, см. scratchpad gen-store.cjs);
// заменены только сантехника: uuid → randomUUID, multer → uploadSingle, pipe(res) → res.sendStream; адрес файла — MEDIA_BASE_URL.
import Database from 'better-sqlite3'
import sharp from 'sharp'
import pngToIco from 'png-to-ico'
import { randomUUID } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, unlinkSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs'
import { resolve, extname } from 'node:path'
import { execSync } from 'node:child_process'
import { PORT, STORAGE_DIR, ICONS_DIR, MEDIA_DB } from './context.mjs'
import { uploadSingle } from './express-shim.mjs'
import { isElementId } from './element-key.mjs'

// 550: адрес файла в записи остаётся адресом БАЗЫ ДАННЫХ узла (`DATA_URL` — сосед data): все потребители зовут /media у неё,
// и она пересылает запрос сюда. Записанный однажды адрес не меняется, когда хранилище переезжает. Нет базы — свой адрес.
const MEDIA_BASE_URL = process.env.DATA_URL || process.env.DATA_PUBLIC_URL || `http://localhost:${PORT}`

export function registerMedia(app) {
  mkdirSync(STORAGE_DIR, { recursive: true })
  mkdirSync(ICONS_DIR, { recursive: true })

  const mediaDb = new Database(MEDIA_DB)
  mediaDb.pragma('journal_mode = WAL')
  
  mediaDb.exec(`
    CREATE TABLE IF NOT EXISTS icon_sets (
      id           TEXT PRIMARY KEY,
      source_id    TEXT NOT NULL,
      generated_at TEXT NOT NULL DEFAULT (datetime('now')),
      files        TEXT NOT NULL
    );
  
    CREATE TABLE IF NOT EXISTS media (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      title       TEXT DEFAULT '',
      description TEXT DEFAULT '',
      url         TEXT NOT NULL,
      mime_type   TEXT NOT NULL,
      extension   TEXT NOT NULL,
      crop_mode   TEXT DEFAULT '',
      size        INTEGER NOT NULL,
      width       INTEGER,
      height      INTEGER,
      duration    REAL,
      -- Размытая копия изображения в виде строки data: — подробности у ALTER ниже.
      blur        TEXT DEFAULT '',
      storage_key TEXT NOT NULL UNIQUE,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
  
  const existingCols = mediaDb.prepare('PRAGMA table_info(media)').all().map(c => c.name)
  // Крошечная размытая копия изображения (шаг 506.3, 2026-08-13).
  //
  // 🔒 ПОЧЕМУ КОЛОНКА, А НЕ ФАЙЛ И НЕ РАСЧЁТ НА ЛЕТУ. Первоисточник (документация
  // Next, `next/image`): `blurDataURL` подставляется сам ТОЛЬКО при статическом
  // импорте файла; для динамического источника — «you must provide blurDataURL
  // yourself». Картинка, загруженная владельцем, динамическая по определению: на
  // сборке её ещё не существует.
  //
  // Считать её при каждом показе нельзя — это чтение файла с диска и декодирование
  // на каждый заход. Класть отдельным файлом тоже неверно: строка нужна ВНУТРИ
  // HTML, иначе она превращается в ещё один запрос и теряет весь смысл. Поэтому она
  // живёт рядом с шириной и высотой — в записи о самом изображении, и приезжает
  // вместе с ней одним ответом.
  //
  // Пустая строка у старых записей — норма, а не поломка: приложение показывает
  // такую картинку без подложки, ровно как раньше.
  if (!existingCols.includes('blur'))        mediaDb.exec(`ALTER TABLE media ADD COLUMN blur TEXT DEFAULT ''`)
  if (!existingCols.includes('title'))       mediaDb.exec(`ALTER TABLE media ADD COLUMN title TEXT DEFAULT ''`)
  if (!existingCols.includes('description')) mediaDb.exec(`ALTER TABLE media ADD COLUMN description TEXT DEFAULT ''`)
  if (!existingCols.includes('url'))         mediaDb.exec(`ALTER TABLE media ADD COLUMN url TEXT NOT NULL DEFAULT ''`)
  if (!existingCols.includes('crop_mode'))   mediaDb.exec(`ALTER TABLE media ADD COLUMN crop_mode TEXT DEFAULT ''`)
  // 654-2: ЧЕЙ ФАЙЛ И ВИДЕН ЛИ ОН СО СТРАНИЦЫ. Всё, что лежало до 654, — узла и публичное: так оно и отдавалось. Файлы глубокой памяти
  // помечает приватными сама память (она знает свои объекты); новые она кладёт приватными сразу.
  if (!existingCols.includes('owner'))       mediaDb.exec(`ALTER TABLE media ADD COLUMN owner TEXT NOT NULL DEFAULT 'node'`)
  if (!existingCols.includes('visibility'))  mediaDb.exec(`ALTER TABLE media ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'`)
  const iconCols = mediaDb.prepare('PRAGMA table_info(icon_sets)').all().map(c => c.name)
  if (!iconCols.includes('owner'))           mediaDb.exec(`ALTER TABLE icon_sets ADD COLUMN owner TEXT NOT NULL DEFAULT 'node'`)

  // 654-2: КТО ЧТО ВИДИТ (владелец 2026-11-05: «объектное хранилище должно быть обновлено не только для использования глубинной
  // памятью но и для использования просто внутри элемента»). Ключ элемента (`req.element`, общий замок) видит свои записи и публичные
  // записи узла, правит и удаляет только свои; чужая запись отвечает 404 — тот же ответ, что у несуществующей. Ключ узла видит всё.
  // 🔒 ПРИВАТНЫЙ ФАЙЛ УХОДИТ ТОЛЬКО ПО ЯВНОЙ ПРОСЬБЕ (`?private=1`) ВЛАДЕЛЬЦА ИЛИ УЗЛА. Публичный маршрут каждого элемента
  // (`/api/media/<id>/file`, ключ узла, без просьбы) с этой минуты приватного не отдаёт — без выпуска самих элементов. ✗ Измерено
  // 2026-11-05: файл памяти `anna-650.txt` (пространство root) отдавался по временному адресу узла любому, кто знал его id.
  const NODE = 'node'
  const sees = (req, item) => !req.element || item.owner === req.element || (item.owner === NODE && item.visibility === 'public')
  const owns = (req, item) => !req.element || item.owner === req.element
  const mayRead = (req, item) => sees(req, item) && (item.visibility !== 'private' || (req.query?.private === '1' && owns(req, item)))

  // Repair a string that is UTF-8 bytes mis-decoded as latin1.
  //
  // The check is deliberately conservative: a genuinely latin1 name ("Café") turns into
  // invalid UTF-8 when re-decoded and yields U+FFFD, so we keep the original. Only a
  // string that was really mojibake round-trips cleanly.
  function fixMojibake(s) {
    if (typeof s !== 'string' || !s) return s
    if (!/[À-ÿ]/.test(s)) return s // no suspicious high-latin1 letters at all
    try {
      const repaired = Buffer.from(s, 'latin1').toString('utf8')
      if (repaired && !repaired.includes('\uFFFD')) return repaired
    } catch { /* keep the original */ }
    return s
  }
  
  // One-time self-healing for rows written before the fix. Idempotent: a name that is
  // already correct does not match the mojibake test and is left alone.
  try {
    const rows = mediaDb.prepare('SELECT id, name, title, description FROM media').all()
    const upd = mediaDb.prepare('UPDATE media SET name = ?, title = ?, description = ? WHERE id = ?')
    let healed = 0
    for (const r of rows) {
      const name = fixMojibake(r.name)
      const title = fixMojibake(r.title)
      const description = fixMojibake(r.description)
      if (name !== r.name || title !== r.title || description !== r.description) {
        upd.run(name, title, description, r.id)
        healed++
      }
    }
    if (healed) console.log(`[media] repaired ${healed} mis-encoded name(s)`)
  } catch (e) {
    console.log(`[media] name repair skipped: ${e.message}`)
  }

  // ── GET /media ────────────────────────────────────────────────────────────────
  
  app.get('/media', (req, res) => {
    // 654-2: элемент — свои записи и публичные записи узла; узел — все, а с `?owner=<id>` — записи одного владельца.
    if (req.element) {
      const own = mediaDb.prepare("SELECT * FROM media WHERE owner = ? OR (owner = 'node' AND visibility = 'public') ORDER BY created_at DESC").all(req.element)
      return res.json({ ok: true, items: own })
    }
    const owner = req.query?.owner
    const rows = owner
      ? mediaDb.prepare('SELECT * FROM media WHERE owner = ? ORDER BY created_at DESC').all(String(owner))
      : mediaDb.prepare('SELECT * FROM media ORDER BY created_at DESC').all()
    res.json({ ok: true, items: rows })
  })
  
  // ── POST /media/upload ────────────────────────────────────────────────────────
  
  app.post('/media/upload', uploadSingle('file', 200 * 1024 * 1024), async (req, res) => {
    try {
      const file = req.file
      if (!file) return res.status(400).json({ ok: false, error: 'No file provided' })
  
      const id         = randomUUID()
      const ext        = extname(file.originalname).replace('.', '').toLowerCase() || 'bin'
      const storageKey = `${id}.${ext}`
      const destPath   = resolve(STORAGE_DIR, storageKey)
      const isImage    = file.mimetype.startsWith('image/')
  
      let width = null, height = null, duration = null, buffer = file.buffer, blur = ''
  
      // The TRUE duration of a video is measured HERE, by ffprobe, and never taken from
      // the browser. A screen recording often carries no usable duration in its
      // container, and the browser then reports a bogus one — the trimmer trusted it and
      // cut a 90-second clip down to two seconds. The server measures the file it just
      // received, so the trimmer gets a number that is actually true.
  
      if (isImage) {
        const meta = await sharp(buffer).metadata()
        width  = meta.width  ?? null
        height = meta.height ?? null
  
        const crop = req.body.crop ? JSON.parse(req.body.crop) : null
        if (crop) {
          buffer = await sharp(buffer)
            .extract({ left: crop.x, top: crop.y, width: crop.w, height: crop.h })
            .toBuffer()
          width  = crop.w
          height = crop.h
        }
  
        // Размытая копия — ПОСЛЕ обрезки, из того буфера, который ляжет на диск.
        // Порядок здесь содержательный: сними её раньше — и подложка показывала бы
        // кадр, которого в файле уже нет, то есть картинка «дёргалась» бы при
        // загрузке сильнее, чем без подложки вовсе.
        //
        // 12 пикселей и webp: документация Next советует «10px or less» и
        // предупреждает, что большая строка вредит — она едет в HTML каждой
        // страницы, где стоит эта картинка. Замер на статике проекта: ~140 байт.
        //
        // Анимированные пропускаем: у них подложка смысла не имеет, а `sharp`
        // сводил бы их к первому кадру.
        try {
          const probe = await sharp(buffer).metadata()
          if ((probe.pages ?? 1) === 1) {
            const tiny = await sharp(buffer)
              .resize({ width: 12, withoutEnlargement: true })
              .webp({ quality: 40 })
              .toBuffer()
            blur = `data:image/webp;base64,${tiny.toString('base64')}`
          }
        } catch {
          // Не вышло — загрузка обязана состояться. Картинка без подложки работает;
          // загрузка, упавшая из-за подложки, не работает вовсе.
        }
      }
  
      await import('fs/promises').then(fs => fs.writeFile(destPath, buffer))
  
      // Video: measure the file we just stored. probeDuration() is defined next to the
      // trim route below (function declaration, hoisted).
      if (file.mimetype.startsWith('video/')) duration = probeDuration(destPath)
  
      const baseUrl = MEDIA_BASE_URL
      const row = {
        id,
        name:        fixMojibake(file.originalname),
        title:       fixMojibake(req.body.title) || "",
        description: fixMojibake(req.body.description) || "",
        url:         `${baseUrl}/media/${id}/file`,
        mime_type:   file.mimetype,
        extension:   ext,
        crop_mode:   req.body.crop_mode || '',
        size:        buffer.length,
        width,
        height,
        duration,
        blur,
        storage_key: storageKey,
        // 654-2: запись — того, кто загрузил (элемент по своему ключу, иначе узел); приватная — только по просьбе загрузившего.
        owner: req.element ?? NODE,
        visibility: req.body?.visibility === 'private' ? 'private' : 'public',
      }
  
      mediaDb.prepare(`
        INSERT INTO media (id, name, title, description, url, mime_type, extension, crop_mode, size, width, height, duration, blur, storage_key, owner, visibility)
        VALUES (@id, @name, @title, @description, @url, @mime_type, @extension, @crop_mode, @size, @width, @height, @duration, @blur, @storage_key, @owner, @visibility)
      `).run(row)
  
      res.json({ ok: true, item: mediaDb.prepare('SELECT * FROM media WHERE id = ?').get(id) })
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e) })
    }
  })
  
  // ── PATCH /media/:id ──────────────────────────────────────────────────────────
  
  app.patch('/media/:id', (req, res) => {
    const { title, description, crop_mode, visibility, owner } = req.body
    const item = mediaDb.prepare('SELECT * FROM media WHERE id = ?').get(req.params.id)
    if (!item || !owns(req, item)) return res.status(404).json({ ok: false, error: 'Not found' })
    // 654-2: видимость меняет владелец записи; владельца — только узел (отдать файл элементу или вернуть узлу).
    const vis = visibility === 'private' || visibility === 'public' ? visibility : item.visibility
    let whose = item.owner
    if (owner !== undefined && !req.element) {
      if (owner !== NODE && !isElementId(owner)) return res.status(400).json({ ok: false, error: 'owner is node or an element id' })
      whose = owner
    }
  
    mediaDb.prepare('UPDATE media SET title = ?, description = ?, crop_mode = ?, visibility = ?, owner = ? WHERE id = ?')
      .run(title ?? item.title ?? '', description ?? item.description ?? '', crop_mode ?? item.crop_mode ?? '', vis, whose, req.params.id)
  
    res.json({ ok: true, item: mediaDb.prepare('SELECT * FROM media WHERE id = ?').get(req.params.id) })
  })
  
  // ── DELETE /media/:id ─────────────────────────────────────────────────────────
  
  app.delete('/media/:id', (req, res) => {
    const item = mediaDb.prepare('SELECT * FROM media WHERE id = ?').get(req.params.id)
    if (!item || !owns(req, item)) return res.status(404).json({ ok: false, error: 'Not found' })
  
    const filePath = resolve(STORAGE_DIR, item.storage_key)
    if (existsSync(filePath)) { try { unlinkSync(filePath) } catch {} }
  
    mediaDb.prepare('DELETE FROM media WHERE id = ?').run(req.params.id)
    res.json({ ok: true })
  })
  
  // ── POST /media/:id/trim — keep the middle of a video ─────────────────────────
  // Body: { start, end } in seconds. Cuts everything before `start` and after `end`.
  //
  // Done with ffmpeg on the server, not in the browser, and deliberately so: with
  // `-c copy` the streams are copied, not re-encoded, so the cut is instant, lossless
  // and costs no CPU worth mentioning — while a browser-side editor would ship ~30 MB
  // of wasm to every visitor and re-encode on their machine. ffmpeg is the industry
  // standard tool for exactly this and is installed by bootstrap.
  //
  // The trim REPLACES the stored object (the owner asked to keep the middle, not to
  // keep two files). Duration and size are refreshed in the row afterwards.
  
  function probeDuration(path) {
    try {
      const out = execSync(
        `ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 ${JSON.stringify(path)}`,
        { encoding: 'utf8', timeout: 20000 },
      ).trim()
      const n = Number(out)
      return Number.isFinite(n) ? n : null
    } catch {
      return null
    }
  }
  
  app.post('/media/:id/trim', (req, res) => {
    const item = mediaDb.prepare('SELECT * FROM media WHERE id = ?').get(req.params.id)
    if (!item || !owns(req, item)) return res.status(404).json({ ok: false, error: 'Not found' })
    if (!String(item.mime_type).startsWith('video/')) {
      return res.status(400).json({ ok: false, error: 'Not a video' })
    }
  
    const start = Number(req.body?.start)
    const end   = Number(req.body?.end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
      return res.status(400).json({ ok: false, error: 'Expected { start, end } with end > start >= 0' })
    }
  
    const src = resolve(STORAGE_DIR, item.storage_key)
    if (!existsSync(src)) return res.status(404).json({ ok: false, error: 'File missing in storage' })
    const tmp = `${src}.trim${extname(item.storage_key) || '.mp4'}`
  
    const wanted = end - start
    try {
      // FAST PATH — copy the streams (`-c copy`): instant and lossless. `-t` is the
      // OUTPUT duration; `-to` must NOT be used here, because with input seeking it is
      // measured against the original timeline in some ffmpeg builds.
      execSync(
        `ffmpeg -y -ss ${start} -i ${JSON.stringify(src)} -t ${wanted} -c copy -avoid_negative_ts make_zero ${JSON.stringify(tmp)}`,
        { timeout: 120000, stdio: 'ignore' },
      )
  
      // …but a stream copy can only cut at KEYFRAMES. When the requested boundary
      // falls between them, ffmpeg still exits 0 and quietly returns a longer clip —
      // measured live: a 3→7 request on a keyframe-poor file gave 7.1s, not 4s. So we
      // MEASURE the result and, if it missed by more than half a second, redo the cut
      // with a re-encode, which is frame-accurate. Slower, but correct; and real-world
      // recordings carry keyframes every few seconds, so this path is rarely taken.
      const got = probeDuration(tmp)
      if (got === null || Math.abs(got - wanted) > 0.5) {
        execSync(
          `ffmpeg -y -ss ${start} -i ${JSON.stringify(src)} -t ${wanted} -c:v libx264 -preset veryfast -c:a aac -movflags +faststart ${JSON.stringify(tmp)}`,
          { timeout: 600000, stdio: 'ignore' },
        )
      }
    } catch (e) {
      if (existsSync(tmp)) { try { unlinkSync(tmp) } catch {} }
      return res.status(500).json({ ok: false, error: `ffmpeg failed: ${String(e.message ?? e)}` })
    }
  
    try {
      const trimmed = readFileSync(tmp)
      writeFileSync(src, trimmed)
      unlinkSync(tmp)
      const duration = probeDuration(src)
      mediaDb.prepare('UPDATE media SET size = ?, duration = ? WHERE id = ?').run(trimmed.length, duration, item.id)
    } catch (e) {
      return res.status(500).json({ ok: false, error: `Could not replace the stored file: ${String(e)}` })
    }
  
    res.json({ ok: true, item: mediaDb.prepare('SELECT * FROM media WHERE id = ?').get(item.id) })
  })
  
  // ── GET /media/:id/file ───────────────────────────────────────────────────────
  
  app.get('/media/:id/file', (req, res) => {
    const item = mediaDb.prepare('SELECT * FROM media WHERE id = ?').get(req.params.id)
    if (!item || !mayRead(req, item)) return res.status(404).end()
  
    const filePath = resolve(STORAGE_DIR, item.storage_key)
    if (!existsSync(filePath)) return res.status(404).end()
  
    res.setHeader('Content-Type', item.mime_type)
    // The URL of a stored object is STABLE, but its CONTENT is not: trimming a video
    // replaces the file in place. With the old `max-age=31536000` the browser kept
    // showing the original for a year — the owner trimmed a clip and Preview still
    // played the full one. So the response revalidates, and an ETag built from the
    // file's own size+mtime makes that revalidation a cheap 304 in the normal case.
    try {
      const st = statSync(filePath)
      res.setHeader('ETag', `"${st.size}-${Math.floor(st.mtimeMs)}"`)
    } catch { /* no ETag — the revalidation just re-sends the body */ }
    // 654-2: приватный файл не кешируется ни у кого по дороге.
    res.setHeader('Cache-Control', item.visibility === 'private' ? 'private, no-store' : 'public, max-age=0, must-revalidate')
    res.sendStream(createReadStream(filePath))
  })
  
  // ── GET /media/:id/thumb ──────────────────────────────────────────────────────
  
  app.get('/media/:id/thumb', async (req, res) => {
    const item = mediaDb.prepare('SELECT * FROM media WHERE id = ?').get(req.params.id)
    if (!item || !mayRead(req, item) || !item.mime_type.startsWith('image/')) return res.status(404).end()
  
    const filePath = resolve(STORAGE_DIR, item.storage_key)
    if (!existsSync(filePath)) return res.status(404).end()
  
    try {
      const thumb = await sharp(filePath).resize(200, 200, { fit: 'cover' }).jpeg({ quality: 80 }).toBuffer()
      res.setHeader('Content-Type', 'image/jpeg')
      res.setHeader('Cache-Control', 'public, max-age=3600')
      res.send(thumb)
    } catch {
      res.status(500).end()
    }
  })
  
  // ── POST /media/generate-icons ────────────────────────────────────────────────
  
  app.post('/media/generate-icons', async (req, res) => {
    try {
      const { media_id } = req.body
      if (!media_id) return res.status(400).json({ ok: false, error: 'media_id required' })
  
      const item = mediaDb.prepare('SELECT * FROM media WHERE id = ?').get(media_id)
      if (!item || !sees(req, item)) return res.status(404).json({ ok: false, error: 'Media not found' })
      if (!item.mime_type.startsWith('image/')) return res.status(400).json({ ok: false, error: 'Source must be an image' })
  
      const srcPath = resolve(STORAGE_DIR, item.storage_key)
      if (!existsSync(srcPath)) return res.status(404).json({ ok: false, error: 'Source file not found' })
  
      const id  = randomUUID()
      const dir = resolve(ICONS_DIR, id)
      mkdirSync(dir, { recursive: true })
  
      const sizes = [16, 32, 180, 192, 512]
      const pngBuffers = {}
      for (const size of sizes) {
        pngBuffers[size] = await sharp(srcPath)
          .resize(size, size, { fit: 'cover', position: 'centre' })
          .png()
          .toBuffer()
      }
  
      writeFileSync(resolve(dir, 'favicon-16.png'),       pngBuffers[16])
      writeFileSync(resolve(dir, 'favicon-32.png'),       pngBuffers[32])
      writeFileSync(resolve(dir, 'apple-touch-icon.png'), pngBuffers[180])
      writeFileSync(resolve(dir, 'icon-192.png'),         pngBuffers[192])
      writeFileSync(resolve(dir, 'icon-512.png'),         pngBuffers[512])
  
      const icoBuffer = await pngToIco([pngBuffers[16], pngBuffers[32]])
      writeFileSync(resolve(dir, 'favicon.ico'), icoBuffer)
  
      const ogBuffer = await sharp(srcPath)
        .resize(1200, 630, { fit: 'cover', position: 'centre' })
        .jpeg({ quality: 90 })
        .toBuffer()
      writeFileSync(resolve(dir, 'og-image.jpg'), ogBuffer)
  
      const baseUrl = MEDIA_BASE_URL
      const manifest = {
        name: 'Fractera Light',
        short_name: 'Fractera',
        icons: [
          { src: `${baseUrl}/media/icons/${id}/file/icon-192.png`, sizes: '192x192', type: 'image/png' },
          { src: `${baseUrl}/media/icons/${id}/file/icon-512.png`, sizes: '512x512', type: 'image/png' },
        ],
        theme_color: '#000000',
        background_color: '#000000',
        display: 'standalone',
      }
      writeFileSync(resolve(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  
      const files = {
        favicon_ico:       `${id}/favicon.ico`,
        favicon_16:        `${id}/favicon-16.png`,
        favicon_32:        `${id}/favicon-32.png`,
        apple_touch_icon:  `${id}/apple-touch-icon.png`,
        icon_192:          `${id}/icon-192.png`,
        icon_512:          `${id}/icon-512.png`,
        og_image:          `${id}/og-image.jpg`,
        manifest:          `${id}/manifest.json`,
      }
  
      mediaDb.prepare(`INSERT INTO icon_sets (id, source_id, files, owner) VALUES (?, ?, ?, ?)`).run(id, media_id, JSON.stringify(files), req.element ?? NODE)
      res.json({ ok: true, id, files })
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e) })
    }
  })
  
  // ── GET /media/icons/current ──────────────────────────────────────────────────
  
  // 654-2: свой набор элемента, иначе набор узла; набор элемента никогда не становится значком всех остальных.
  app.get('/media/icons/current', (req, res) => {
    const row = (req.element && mediaDb.prepare('SELECT * FROM icon_sets WHERE owner = ? ORDER BY generated_at DESC LIMIT 1').get(req.element))
      || mediaDb.prepare("SELECT * FROM icon_sets WHERE owner = 'node' ORDER BY generated_at DESC LIMIT 1").get()
    if (!row) return res.status(404).json({ ok: false, error: 'No icon sets generated yet' })
    res.json({ ok: true, ...row, files: JSON.parse(row.files) })
  })
  
  // ── GET /media/icons ──────────────────────────────────────────────────────────
  
  // ── DELETE /media/icons/:id — снять набор иконок ─────────────────────────────
  //
  // 🔒 ЗАЧЕМ ЭТОТ МАРШРУТ ПОЯВИЛСЯ (найдено проверкой возможностей 2026-08-23).
  // Набор иконок можно было СОЗДАТЬ и нельзя было УДАЛИТЬ: у владельца не было
  // способа отменить сгенерированный значок сайта, кроме как сгенерировать поверх
  // новый. Дыра тихая — она не мешает, пока не понадобится откатить.
  //
  // 🔒 ФАЙЛЫ И ЗАПИСЬ УХОДЯТ ВМЕСТЕ. Оставить папку без записи значит копить
  // мегабайты, о которых не знает никто; оставить запись без папки — отдавать
  // битые ссылки на значок с каждой страницы сайта.
  app.delete('/media/icons/:id', (req, res) => {
    const row = mediaDb.prepare('SELECT * FROM icon_sets WHERE id = ?').get(req.params.id)
    if (!row || !owns(req, row)) return res.status(404).json({ ok: false, error: 'Icon set not found' })
    const dir = resolve(ICONS_DIR, req.params.id)
    try {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e) })
    }
    mediaDb.prepare('DELETE FROM icon_sets WHERE id = ?').run(req.params.id)
    res.json({ ok: true })
  })
  
  
  app.get('/media/icons', (req, res) => {
    const rows = req.element
      ? mediaDb.prepare("SELECT * FROM icon_sets WHERE owner = ? OR owner = 'node' ORDER BY generated_at DESC").all(req.element)
      : mediaDb.prepare('SELECT * FROM icon_sets ORDER BY generated_at DESC').all()
    res.json({ ok: true, items: rows.map(r => ({ ...r, files: JSON.parse(r.files) })) })
  })
  
  // ── GET /media/icons/:id/file/:name ──────────────────────────────────────────
  
  app.get('/media/icons/:id/file/:name', (req, res) => {
    const row = mediaDb.prepare('SELECT * FROM icon_sets WHERE id = ?').get(req.params.id)
    // Значки — публичные файлы бренда: элемент берёт свои и узла, узел — любые.
    if (!row || (req.element && row.owner !== req.element && row.owner !== NODE)) return res.status(404).end()
  
    const filePath = resolve(ICONS_DIR, req.params.id, req.params.name)
    if (!existsSync(filePath)) return res.status(404).end()
  
    const ext  = req.params.name.split('.').pop()
    const mime = ext === 'ico' ? 'image/x-icon' : ext === 'jpg' ? 'image/jpeg' : ext === 'json' ? 'application/json' : 'image/png'
  
    res.setHeader('Content-Type', mime)
    res.setHeader('Cache-Control', 'public, max-age=3600')
    res.sendStream(createReadStream(filePath))
  })
  
}
