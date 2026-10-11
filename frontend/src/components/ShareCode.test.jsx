import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ShareCode from './ShareCode.jsx'

describe('ShareCode', () => {
  it('copia el código al portapapeles', async () => {
    const user = userEvent.setup()
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
    render(<ShareCode code="ABC123" link="/family?code=ABC123" text="Únete" />)
    expect(screen.getByText('ABC123')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Copiar código' }))
    expect(writeText).toHaveBeenCalledWith('ABC123')
  })

  it('comparte un enlace a la app con el código puesto', async () => {
    const share = vi.fn().mockResolvedValue()
    Object.defineProperty(navigator, 'share', { value: share, configurable: true })
    render(<ShareCode code="ABC123" link="/login?invite=ABC123" text="Te invito" />)
    await userEvent.click(screen.getByRole('button', { name: /Compartir enlace/ }))
    expect(share).toHaveBeenCalledWith({ title: 'flossy', text: 'Te invito', url: `${location.origin}${location.pathname}#/login?invite=ABC123` })
    delete navigator.share
  })

  it('sin menú de compartir, copia el enlace', async () => {
    const user = userEvent.setup()
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
    render(<ShareCode code="ABC123" link="/family?code=ABC123" text="x" />)
    await user.click(screen.getByRole('button', { name: /Compartir enlace/ }))
    expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/#\/family\?code=ABC123$/))
  })

  it('mientras llega el código no ofrece copiar ni compartir', () => {
    render(<ShareCode code={null} link="/x" text="x" />)
    expect(screen.queryByRole('button')).toBeNull()
  })
})
