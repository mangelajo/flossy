// Recorridos completos por la app, con la API, el servicio de visión y el frontend de verdad.
// Van en orden y comparten datos: el primero crea la administradora.
import { test, expect } from '@playwright/test'

test.describe.configure({ mode: 'serial' })

const PASSWORD = 'contraseña-de-prueba-larga'
let invite = ''

async function signUp(page, name, { code } = {}) {
  await page.getByRole('button', { name: 'Contraseña', exact: true }).click()
  await page.getByPlaceholder('Tu nombre').fill(name)
  await page.getByPlaceholder('Contraseña', { exact: true }).fill(PASSWORD)
  if (code !== undefined) await expect(page.getByPlaceholder('Código de invitación')).toHaveValue(code)
  await page.getByRole('button', { name: 'Crear perfil' }).last().click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText(name)
}

async function signIn(page, name) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Entrar con contraseña' }).click()
  await page.getByPlaceholder('Nombre').fill(name)
  await page.getByPlaceholder('Contraseña').fill(PASSWORD)
  await page.getByRole('button', { name: 'Entrar', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText(name)
}

test('el primer perfil se crea sin invitación y es administrador', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('El primer perfil que crees será el administrador.')).toBeVisible()
  await page.getByRole('button', { name: 'Crear perfil' }).click()
  await signUp(page, 'Ana')
  await page.getByRole('button', { name: 'Ajustes' }).click()
  await expect(page.getByText('Administrador')).toBeVisible()
})

test('sesión guiada: la cámara habla con el servicio de visión y se puede salir', async ({ page }) => {
  await signIn(page, 'Ana')
  await page.getByRole('button', { name: 'Cepillar' }).click()
  await expect(page.getByRole('heading', { name: 'Cepillado + seda' })).toBeVisible()

  // antes de empezar siempre hay forma de volver (la app instalada no tiene botón de atrás)
  await page.getByRole('button', { name: 'Inicio' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Ana')

  await page.getByRole('button', { name: 'Cepillar' }).click()
  await page.getByRole('button', { name: 'Empezar', exact: true }).click()
  // la primera respuesta del servidor trae la sesión guiada: zona 1 de 12
  await expect(page.getByText('Zona 1 de 12')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('Cepilla arriba a tu izquierda')).toBeVisible()
  await expect(page.getByText('No te veo la cara')).toBeVisible()            // la cámara falsa no tiene cara
  await page.getByRole('button', { name: 'Terminar' }).click()
  await expect(page.getByText('Sesión terminada').first()).toBeVisible()
})

test('una invitación se comparte como enlace y abre el alta con el código puesto', async ({ page, browser }) => {
  await signIn(page, 'Ana')
  await page.getByRole('button', { name: 'Ajustes' }).click()
  await page.getByText('Nuevo código de invitación').click()
  const code = page.locator('.sharecode span')
  await expect(code).toHaveText(/^[A-Z0-9]{8}$/)
  invite = await code.textContent()
  await expect(page.getByRole('button', { name: 'Compartir enlace' })).toBeVisible()

  const other = await browser.newContext()
  const guest = await other.newPage()
  await guest.goto(`/#/login?invite=${invite}`)
  await expect(guest.getByRole('heading', { name: 'Crear perfil' })).toBeVisible()
  await signUp(guest, 'Pepe', { code: invite })
  await other.close()
})

test('sin invitación ya no se puede crear un perfil', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Crear perfil' }).click()
  await page.getByRole('button', { name: 'Contraseña', exact: true }).click()
  await page.getByPlaceholder('Tu nombre').fill('Intruso')
  await page.getByPlaceholder('Contraseña', { exact: true }).fill(PASSWORD)
  await page.getByPlaceholder('Código de invitación').fill(invite)    // ya usado
  await page.getByRole('button', { name: 'Crear perfil' }).last().click()
  await expect(page.getByText('Ese código de invitación no es válido.')).toBeVisible()
})

test('familia: crear un niño, ponerle horario, marcar a mano y deshacer', async ({ page }) => {
  await signIn(page, 'Ana')
  await page.getByRole('button', { name: 'Familia' }).click()
  await page.getByRole('button', { name: 'Añadir' }).click()
  await page.getByPlaceholder('Nombre').fill('Lucía')
  await page.getByPlaceholder(/Contraseña/).fill('lucia-contraseña-1')
  await page.getByRole('button', { name: 'Crear perfil' }).last().click()   // el primero es la pestaña
  await page.getByRole('button', { name: /Lucía/ }).click()
  await expect(page.getByRole('heading', { name: 'Lucía' })).toBeVisible()

  // un horario que dure todo el día, para que siempre haya una franja «ahora»
  await page.getByText('Horario', { exact: true }).click()
  for (const name of ['Mañana', 'Noche']) {
    await page.getByText(new RegExp(`^${name} ·`)).click()
    await page.getByRole('button', { name: 'Borrar' }).click()
  }
  await page.getByText('Añadir sesión').click()
  await page.getByPlaceholder(/Nombre/).fill('Todo el día')
  await page.getByLabel('Desde').fill('00:00')
  await page.getByLabel('Hasta').fill('23:59')
  await page.getByRole('button', { name: 'Guardar' }).click()
  await expect(page.getByText('Todo el día · 00:00–23:59')).toBeVisible()
  await page.getByRole('button', { name: 'Volver' }).click()

  await page.getByRole('button', { name: 'Marcar hecha' }).click()
  await expect(page.getByRole('button', { name: /A mano · deshacer/ })).toBeVisible()
  await expect(page.getByText('Racha: 1 día')).toBeVisible()
  await page.getByRole('button', { name: /A mano · deshacer/ }).click()
  await expect(page.getByRole('button', { name: 'Marcar hecha' })).toBeVisible()
})

test('dejar de ser tutor pide escribir el nombre del niño', async ({ page }) => {
  await signIn(page, 'Ana')
  await page.getByRole('button', { name: 'Familia' }).click()
  await page.getByRole('button', { name: /Lucía/ }).click()
  await page.getByText('Dejar de ser su tutor').click()
  const confirm = page.getByRole('button', { name: 'Dejar de ser su tutor' }).last()   // el de la hoja, no la fila
  await expect(confirm).toBeDisabled()
  await page.getByPlaceholder('Lucía').fill('Pablo')
  await expect(confirm).toBeDisabled()
  await page.getByPlaceholder('Lucía').fill('lucia')
  await confirm.click()
  await expect(page.getByText('Añade a los niños')).toBeVisible()
})

test('el enlace de un código de tutor abre «Vincular» una sola vez, con el código puesto', async ({ page, browser }) => {
  // Pepe genera su código (Ajustes → Código para un tutor) y Ana abre el enlace
  const other = await browser.newContext()
  const pepe = await other.newPage()
  await signIn(pepe, 'Pepe')
  await pepe.getByRole('button', { name: 'Ajustes' }).click()
  await pepe.getByText('Código para un tutor').click()
  const code = pepe.locator('.sharecode span')
  await expect(code).toHaveText(/^[A-Z0-9]{6,}$/)
  const value = await code.textContent()
  await other.close()

  await signIn(page, 'Ana')
  await page.goto(`/#/family?code=${value}`)
  await expect(page.getByRole('heading', { name: 'Añadir a la familia' })).toHaveCount(1)
  await expect(page.getByPlaceholder('CÓDIGO')).toHaveValue(value)
  await page.getByRole('button', { name: 'Vincular' }).click()
  await expect(page.getByRole('button', { name: /Pepe/ })).toBeVisible()
})
