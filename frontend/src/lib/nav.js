import { useNavigate } from 'react-router-dom'

/** «Volver»: a la pantalla anterior de la app si la hay; si se entró directamente (un enlace, o la
    app instalada en la pantalla de inicio, que no tiene botón de atrás), a `fallback`. */
export function useBack(fallback = '/home') {
  const nav = useNavigate()
  return () => (window.history.state?.idx > 0 ? nav(-1) : nav(fallback, { replace: true }))
}
