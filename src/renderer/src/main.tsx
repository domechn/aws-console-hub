import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { observeTheme } from './theme'
import './styles.css'

observeTheme((preference, resolved) => window.api.setAppTheme(preference, resolved))
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
