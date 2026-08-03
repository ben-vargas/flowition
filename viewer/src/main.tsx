// The SPA entry point. `/boot-theme.js` has already set `data-theme` on <html> by the
// time this runs (§9.9) — nothing here may set it, or the no-flash guarantee dies.

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App.js'
import { claimPressableStyleSlot } from './ui/pressableStyle.js'
import './ui/tokens.css'
import './ui/base.css'
import './ui/primitives.css'

const host = document.getElementById('root')
if (!host) throw new Error('#root is missing from index.html')
// Before the first render, and therefore before any pressable can mount: react-aria
// would otherwise prepend a <style> element that `style-src 'self'` blocks (§7.1.4).
// base.css ships the rule instead — see ui/pressableStyle.ts.
claimPressableStyleSlot()
createRoot(host).render(<StrictMode><App /></StrictMode>)
