// Un código grande con botón de copiar y un enlace para compartir (menú de compartir del móvil
// o, si no lo hay, al portapapeles). Lo usan las invitaciones y los códigos de tutor.
import { toast } from '../store/useUI.js'
import Icon from './Icon.jsx'
import { Button } from './ui.jsx'

async function copy(text, what) {
  try { await navigator.clipboard.writeText(text); toast(`${what} copiado`) }
  catch { toast('No se pudo copiar') }
}

export async function shareLink(url, text) {
  if (navigator.share) {
    try { await navigator.share({ title: 'flossy', text, url }); return }
    catch (e) { if (e.name === 'AbortError') return }
  }
  copy(url, 'Enlace')
}

/** link: ruta dentro de la app, p. ej. '/login?invite=ABC' */
export default function ShareCode({ code, link, text }) {
  const url = `${location.origin}${location.pathname}#${link}`
  return <>
    <div className="sharecode">
      <span>{code || '…'}</span>
      {code && <button className="copy" aria-label="Copiar código" onClick={() => copy(code, 'Código')}><Icon name="copy" /></button>}
    </div>
    {code && <Button variant="tinted" icon="share" onClick={() => shareLink(url, text)}>Compartir enlace</Button>}
  </>
}
