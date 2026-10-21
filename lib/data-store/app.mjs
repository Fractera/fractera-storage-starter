// 550: объектное хранилище узла — медиа прежнего слоя данных: `/health` без ключа → только с этой машины → ключ или
// сессия → право по классу → `/media/*` → `/capabilities`. Замок тот же, что у базы данных (`auth.mjs` дословно общий):
// база пересылает сюда прежние адреса `/media/*` вместе с ключом и кукой, и ответ обязан быть тем же.
//
// 🔒 ОДИН ЭКЗЕМПЛЯР НА ПРОЦЕСС (`globalThis`): сборщик кладёт этот модуль в каждый маршрут, и без общей копии каждый
// открыл бы свою базу и повторил бы разовую починку имён при старте.
import { createApp, dispatch, listRoutes } from './express-shim.mjs'
import { onlyFromThisMachine, requireAuth, requireCapability, PRIVILEGED_ROLES } from './auth.mjs'
import { registerMedia } from './media.mjs'

function build() {
  const app = createApp()

  // ── GET /health — no auth ──
  app.get('/health', (_req, res) => res.json({ ok: true }))

  app.use(onlyFromThisMachine)
  app.use(requireAuth)
  app.use(requireCapability)

  registerMedia(app)

  // ── GET /capabilities — элемент описывает СЕБЯ САМ: список порождается из зарегистрированных маршрутов, ключей нет.
  app.get('/capabilities', (req, res) => {
    res.json({
      service: 'fractera-storage',
      generatedAt: new Date().toISOString(),
      auth: {
        machine: { header: 'x-data-secret', identity: 'x-agent-identity (optional)' },
        human: { cookie: true, requiredRoles: [...PRIVILEGED_ROLES] },
      },
      limits: { uploadBytes: 200 * 1024 * 1024 },
      routes: listRoutes(app),
    })
  })

  return app
}

export function storageApp() {
  globalThis.__fracteraStorageApp ??= build()
  return globalThis.__fracteraStorageApp
}

/** Обработчик маршрута Next: весь запрос — в двери хранилища. */
export async function handle(request) {
  return dispatch(storageApp(), request)
}
