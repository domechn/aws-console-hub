import { contextBridge, ipcRenderer } from 'electron'
import type { ToastApi } from '../shared/api'
import type { ToastInput } from '../shared/types'

const api: ToastApi = {
  platform: process.platform,
  systemDark: ipcRenderer.sendSync('app:system-dark') as boolean,
  themePreference: ipcRenderer.sendSync('app:theme-preference') as ToastApi['themePreference'],
  onSystemDark: (cb) => {
    const listener = (_e: unknown, dark: boolean): void => cb(dark)
    ipcRenderer.on('app:system-dark-changed', listener)
    return () => ipcRenderer.removeListener('app:system-dark-changed', listener)
  },
  onToast: (cb) => {
    const listener = (_e: unknown, toast: ToastInput): void => cb(toast)
    ipcRenderer.on('toast:push', listener)
    return () => ipcRenderer.removeListener('toast:push', listener)
  },
  ready: () => ipcRenderer.send('toast:ready'),
  resize: (height) => ipcRenderer.send('toast:size', height),
  dismissed: () => ipcRenderer.send('toast:dismissed'),
  copy: (text) => ipcRenderer.send('toast:copy', text)
}

contextBridge.exposeInMainWorld('toastApi', api)
