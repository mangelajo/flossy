// Borra el directorio de datos temporal de la ejecución (ver playwright.config.js).
import fs from 'node:fs'

export default () => {
  if (process.env.FLOSSY_E2E_DATA) fs.rmSync(process.env.FLOSSY_E2E_DATA, { recursive: true, force: true })
}
