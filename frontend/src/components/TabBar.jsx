import { useLocation, useNavigate } from 'react-router-dom'
import Icon from './Icon.jsx'

function Tab({ active, icon, label, onClick }) {
  return (
    <button className={active ? 'on' : ''} onClick={onClick}>
      <span className="tab-ic"><Icon name={icon} /></span><span>{label}</span>
    </button>
  )
}

export default function TabBar() {
  const nav = useNavigate()
  const cur = useLocation().pathname.split('/')[1] || 'home'
  return (
    <nav id="tabbar">
      <Tab active={cur === 'home'} icon="house" label="Inicio" onClick={() => nav('/home')} />
      <Tab active={cur === 'history'} icon="calendar" label="Historial" onClick={() => nav('/history')} />
      <button className={'start' + (cur === 'session' ? ' on' : '')} onClick={() => nav('/session?mode=both')}>
        <span className="cir"><Icon name="tooth" /></span><span>Cepillar</span>
      </button>
      <Tab active={cur === 'family'} icon="person" label="Familia" onClick={() => nav('/family')} />
      <Tab active={cur === 'settings' || cur === 'schedule'} icon="gear" label="Ajustes" onClick={() => nav('/settings')} />
    </nav>
  )
}
