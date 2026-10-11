import { describe, it, expect } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { HashRouter, Routes, Route, useNavigate } from 'react-router-dom'
import { useBack } from './nav.js'

function Page({ name }) {
  const back = useBack('/home'), nav = useNavigate()
  return <><h1>{name}</h1><button onClick={back}>Volver</button><button onClick={() => nav('/b')}>Ir a B</button></>
}

const app = () => render(
  <HashRouter><Routes>
    <Route path="/home" element={<Page name="home" />} />
    <Route path="/a" element={<Page name="a" />} />
    <Route path="/b" element={<Page name="b" />} />
  </Routes></HashRouter>
)

describe('useBack', () => {
  it('sin pantalla anterior (entrada directa o app instalada) lleva a la alternativa', () => {
    window.history.replaceState(null, '', '#/a')
    app()
    act(() => screen.getByText('Volver').click())
    expect(screen.getByRole('heading')).toHaveTextContent('home')
  })

  it('con pantalla anterior vuelve a ella', async () => {
    window.history.replaceState(null, '', '#/a')
    app()
    act(() => screen.getByText('Ir a B').click())
    expect(screen.getByRole('heading')).toHaveTextContent('b')
    act(() => screen.getByText('Volver').click())
    expect(await screen.findByRole('heading', { name: 'a' })).toBeInTheDocument()
  })
})
