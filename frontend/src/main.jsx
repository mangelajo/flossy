import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import { bindUI } from './components/ui.jsx'
import { useUI } from './store/useUI.js'
import './index.css'
import './flossy.css'

bindUI(useUI)
createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>)
