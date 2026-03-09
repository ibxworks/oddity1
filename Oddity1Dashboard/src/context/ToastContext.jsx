import { createContext, useContext, useState, useCallback } from 'react'

const ToastContext = createContext()

export function useToast() {
  return useContext(ToastContext)
}

export function ToastProvider({ children }) {
  const [toast, setToast] = useState(null)
  const [visible, setVisible] = useState(false)

  const showToast = useCallback((message, duration = 3000) => {
    setToast(message)
    setVisible(true)
    setTimeout(() => {
      setVisible(false)
      setTimeout(() => setToast(null), 300)
    }, duration)
  }, [])

  return (
    <ToastContext.Provider value={showToast}>
      {children}
      {toast && (
        <div className={`toast ${visible ? 'toast--visible' : ''}`}>
          {toast}
        </div>
      )}
    </ToastContext.Provider>
  )
}
