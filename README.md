# fractera-storage — the object storage of a Fractera node

A native element of the node, built on the Fractera native element template. It keeps the files of every element: pictures,
videos and documents, each with a permanent address, plus thumbnails, blurred placeholders, video trimming and site icon sets.

It was the media part of the former data layer (an Express server) until step 550, when the owner split the data layer into
native elements: **data** (the database), **storage** (this one), **vectors** and **graph**. Consumers did not change: they call
`/media/*` on the database element, which passes the request here as it is and returns the answer unchanged. The address
written into each file record is the database element's address (`DATA_URL`), so a stored address never changes when the
storage moves.

## Doors

Every door but `/health` needs the node data key (`X-Data-Secret`, the same `DATA_SECRET` the installer writes to every
element) or a privileged session (architect, admin, agent) checked by the node's auth element. Through the Cloudflare tunnel
(`cf-ray`) every door answers 404, with a key or without. The lock is `lib/data-store/auth.mjs`, word for word the database's.

| Door | Method | Gives |
|---|---|---|
| `/health` | GET | `{ ok: true }`, no key |
| `/capabilities` | GET | the doors of this element |
| `/media` | GET | `{ ok, items }` — every file record, newest first |
| `/media/upload` | POST | multipart, field `file` (≤ 200 MB); optional `title`, `description`, `crop` (JSON `{x,y,w,h}`), `crop_mode` |
| `/media/:id` | PATCH | `{ title?, description?, crop_mode? }` |
| `/media/:id` | DELETE | the file and its record |
| `/media/:id/trim` | POST | `{ start, end }` seconds of a video to keep (ffmpeg, stream copy, re-encode when the cut misses a keyframe) |
| `/media/:id/file` | GET | the file (ETag from size and time, revalidated on every use) |
| `/media/:id/thumb` | GET | a 200×200 JPEG thumbnail of a picture |
| `/media/generate-icons` | POST | `{ media_id }` → favicon, app icons, share picture, manifest |
| `/media/icons`, `/media/icons/current` | GET | icon sets, the newest one |
| `/media/icons/:id` | DELETE | an icon set and its files |
| `/media/icons/:id/file/:name` | GET | one file of an icon set |

Example — upload a picture from another element (through the database element, as every consumer does):

```js
const form = new FormData()
form.append('file', new Blob([bytes], { type: 'image/png' }), 'logo.png')
form.append('title', 'Logo')
const r = await fetch(`${process.env.REMOTE_DATA_URL}/media/upload`, {
  method: 'POST',
  headers: { 'X-Data-Secret': process.env.DATA_SECRET },
  body: form,
})
const { item } = await r.json() // item.url — the permanent address of the file
```

## Where things live

- `lib/data-store/media.mjs` — the media handlers of the former `server.js`, moved verbatim (uuid → `randomUUID`, multer →
  `uploadSingle`, `pipe(res)` → `res.sendStream`, the file address → `MEDIA_BASE_URL`).
- `lib/data-store/express-shim.mjs` — the Express shape over Next route handlers; `app.mjs` — the order of the doors.
- `app/media/[[...path]]/route.ts`, `app/health/route.ts`, `app/capabilities/route.ts` — the route files.
- Files and records — `data/media.db`, `storage/`, `icons/` in the element folder, never in git.

## Environment

`DATA_SECRET` (shared), `DATA_URL` (the database element — the address written into records), `AUTH_SERVICE_URL`.
Video measuring and trimming need `ffmpeg` and `ffprobe` on the machine; without them the length of a video is empty and
trimming answers 500 naming ffmpeg.

## Extending

A new media door: a handler in `lib/data-store/media.mjs`. A new root segment needs a route file, a line in `DATA_DOOR_ROOTS` of
`proxy.ts` and in `scripts/check-routes.mjs` — and the database element must pass that segment here too, or consumers will not
reach it at the usual address. Changing a door is the owner's decision.

## What it does not do

It does not serve files to the internet: its doors answer only programs of this machine. It converts pictures only into
thumbnails and icons.

## Proven by

Step 550: the same requests to the former data service and to this element return the same status, shape and bytes
(`/code/scripts/agent-tokens/door-parity.mjs`), including the files and thumbnails.

License: MIT.
