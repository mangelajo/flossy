import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SlotList, Calendar } from './Slots.jsx'

const slot = (id, status, extra = {}) => ({ id, name: id, start: '20:00', end: '22:00', mode: 'both', status, ...extra })

describe('SlotList', () => {
  it('sin franjas lo dice', () => {
    render(<SlotList slots={[]} />)
    expect(screen.getByText(/no hay sesiones programadas/i)).toBeInTheDocument()
  })

  it('muestra el estado de cada franja', () => {
    render(<SlotList slots={[slot('a', 'done'), slot('b', 'open'), slot('c', 'upcoming'), slot('d', 'missed')]} />)
    for (const label of ['Hecha', 'Ahora', 'Más tarde', 'No hecha']) expect(screen.getByText(label)).toBeInTheDocument()
    expect(screen.getAllByText('Cepillado + seda')).toHaveLength(4)
  })

  it('«Empezar» solo en la franja de ahora', async () => {
    const onStart = vi.fn()
    render(<SlotList slots={[slot('a', 'open'), slot('b', 'missed')]} onStart={onStart} />)
    expect(screen.getAllByRole('button', { name: 'Empezar' })).toHaveLength(1)
    await userEvent.click(screen.getByRole('button', { name: 'Empezar' }))
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }))
  })

  it('los tutores marcan las de ahora y las pasadas, no las que aún no han empezado', async () => {
    const onMark = vi.fn()
    render(<SlotList slots={[slot('a', 'open'), slot('b', 'missed'), slot('c', 'upcoming'), slot('d', 'done')]} onMark={onMark} />)
    const buttons = screen.getAllByRole('button', { name: 'Marcar hecha' })
    expect(buttons).toHaveLength(2)
    await userEvent.click(buttons[1])
    expect(onMark).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }))
  })

  it('las marcadas a mano se pueden deshacer; las hechas de verdad, no', async () => {
    const onUnmark = vi.fn()
    render(<SlotList slots={[slot('a', 'done', { manual: true }), slot('b', 'done')]} onMark={() => {}} onUnmark={onUnmark} />)
    await userEvent.click(screen.getByRole('button', { name: /deshacer/ }))
    expect(onUnmark).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }))
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })

  it('sin permiso, una marcada a mano solo se ve como «A mano»', () => {
    render(<SlotList slots={[slot('a', 'done', { manual: true })]} />)
    expect(screen.getByText('A mano')).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('Calendar', () => {
  const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const daysAgo = n => { const d = new Date(); d.setDate(d.getDate() - n); return d }

  it('colorea cada día según las franjas hechas', () => {
    const days = { [iso(daysAgo(1))]: { total: 2, done: 2 }, [iso(daysAgo(2))]: { total: 2, done: 1 }, [iso(daysAgo(3))]: { total: 2, done: 0 } }
    const { container } = render(<Calendar days={days} />)
    const cell = n => [...container.querySelectorAll('.d')].find(c => c.title && c.textContent === String(daysAgo(n).getDate()) && c.title === `${days[iso(daysAgo(n))].done}/2`)
    expect(cell(1)).toHaveClass('l2')
    expect(cell(2)).toHaveClass('l1')
    expect(cell(3)).toHaveClass('miss')
    expect(container.querySelectorAll('.d')).toHaveLength(42)
    expect(container.querySelector('.today')).toHaveTextContent(String(new Date().getDate()))
  })
})
