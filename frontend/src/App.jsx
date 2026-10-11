import { useEffect } from 'react'
import { HashRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { useAuth } from './store/useAuth.js'
import Icon from './components/Icon.jsx'
import Modals from './components/Modals.jsx'
import Toast from './components/Toast.jsx'
import TabBar from './components/TabBar.jsx'
import Login from './views/Login.jsx'
import Home from './views/Home.jsx'
import Session from './views/Session.jsx'
import History from './views/History.jsx'
import Settings from './views/Settings.jsx'
import Schedule from './views/Schedule.jsx'
import Family, { FamilyChild } from './views/Family.jsx'

function Shell() {
  const { ready, user } = useAuth()
  const loc = useLocation()
  // Durante la sesión no hay barra de pestañas: toda la pantalla para la cámara.
  const inSession = loc.pathname === '/session'
  useEffect(() => {
    document.body.classList.toggle('no-tabbar', inSession || !user)
  }, [inSession, user])

  if (!ready) return (
    <div id="app"><div style={{ paddingTop: '44vh', display: 'flex', justifyContent: 'center', fontSize: 34, color: 'var(--label-3)' }}><Icon name="tooth" /></div></div>
  )
  return (
    <>
      <div id="app" className="vfade" key={loc.pathname}>
        {!user ? <Login /> : (
          <Routes>
            <Route path="/home" element={<Home />} />
            <Route path="/session" element={<Session />} />
            <Route path="/history" element={<History />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/schedule/:id" element={<Schedule />} />
            <Route path="/family" element={<Family />} />
            <Route path="/family/:id" element={<FamilyChild />} />
            <Route path="*" element={<Navigate to="/home" replace />} />
          </Routes>
        )}
      </div>
      {user && !inSession && <TabBar />}
      <Modals />
      <Toast />
    </>
  )
}

export default function App() {
  const boot = useAuth(s => s.boot)
  useEffect(() => { boot() }, [boot])
  return <HashRouter><Shell /></HashRouter>
}
