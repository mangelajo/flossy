import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { UnlinkSheet } from './Family.jsx'

describe('dejar de ser tutor', () => {
  const setup = () => {
    const close = vi.fn(), onConfirm = vi.fn()
    render(<UnlinkSheet name="Lucía" close={close} onConfirm={onConfirm} />)
    return { close, onConfirm, button: screen.getByRole('button', { name: /Dejar de ser su tutor/ }), input: screen.getByRole('textbox') }
  }

  it('no se puede confirmar sin escribir el nombre', async () => {
    const { button, input, onConfirm } = setup()
    expect(button).toBeDisabled()
    await userEvent.type(input, 'Luc')
    expect(button).toBeDisabled()
    await userEvent.click(button)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('el nombre vale sin tildes ni mayúsculas', async () => {
    const { button, input, onConfirm, close } = setup()
    await userEvent.type(input, '  lucia ')
    expect(button).toBeEnabled()
    await userEvent.click(button)
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalled()
  })

  it('otro nombre no vale', async () => {
    const { button, input } = setup()
    await userEvent.type(input, 'Pablo')
    expect(button).toBeDisabled()
  })
})
