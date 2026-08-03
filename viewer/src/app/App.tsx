// The app shell and router outlet (DESIGN §2.2, §3.7).
//
// W8b owns the shell, the run rail and Home. The cockpit (W11), the transcript panel
// (W10) and the result view (W12) mount into the same outlet; until they land, their
// routes render an explicit, honest placeholder rather than a blank frame — the same
// rule §6.5 applies to degraded data applies to unbuilt screens.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { api, getToken, setToken, subscribeToken } from '../api/client.js'
import type { Session } from '../api/types.js'
import { Icon, IconSprite } from '../ui/Icon.js'
import { ControlProvider } from '../features/control/ControlProvider.js'
import { ControlsLockedChip } from '../features/control/Locked.js'
import { Home } from '../features/home/Home.js'
import { Cockpit } from '../features/cockpit/Cockpit.js'
import { TranscriptRoute } from '../features/transcript/Transcript.js'
import { ResultRoute } from '../features/result/Result.js'
import { RunRail } from './RunRail.js'
import { href, navigate, routeRunId } from './router.js'
import { usePoll, useRoute } from './hooks.js'
import { installThemeSync, isTypingTarget, toggleTheme } from '../theme/theme.js'
import './shell.css'

export function App() {
  const route = useRoute()
  const activeRunId = routeRunId(route)
  // The read token as STATE, not as a value read once during render (§7.1.2). Any request
  // that 401s clears it in api/client.ts; this is how the shell finds out.
  const token = useSyncExternalStore(subscribeToken, getToken, () => null)

  // §2.7 / parity #111: `d` toggles the theme, ignored while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (isTypingTarget(e.target)) return
      if (e.key === 'd') { toggleTheme(); e.preventDefault() }
    }
    window.addEventListener('keydown', onKey)
    const teardown = installThemeSync()
    return () => { window.removeEventListener('keydown', onKey); teardown() }
  }, [])

  // The session route is the capability bootstrap AND the auth probe: a 401 here is what
  // turns the app into the paste-token screen, exactly once, without a redirect loop
  // (critique M7 / Sol-6).
  //
  // `token` is the request's identity, so a credential that changes — pasted, replaced, or
  // REVOKED by a 401 anywhere in the app — re-probes the session rather than leaving the
  // shell mounted over data the server would no longer serve.
  const session = usePoll<Session>((signal) => api.session(signal), {
    intervalMs: 0,
    deps: [token],
  })

  const onToken = useCallback((next: string) => { setToken(next) }, [])

  // "We had a credential and it was taken away" is knowable IMMEDIATELY, and it is the
  // honest gate: waiting for the re-probe to come back 401 would keep an authenticated
  // frame — with its stale rows — on screen for a whole round trip after the viewer has
  // already refused us. A pasted token clears the flag by being a token again.
  const hadToken = useRef(false)
  if (token) hadToken.current = true
  const revoked = hadToken.current && !token

  const denied = session.error?.unauthorized || (!token && session.error != null)
  if (revoked || denied) {
    const reason = session.error?.message
      ?? 'the read token was rejected — paste it again, or print a fresh URL'
    return <TokenGate onToken={onToken} reason={reason} />
  }

  // W12's control layer wraps the whole shell: it owns the §7.2/§7.3 confirmation dialogs,
  // the ⌘K palette, the `?` overlay and the `role=status` toasts, and it hands the cockpit
  // and the transcript their write surfaces through context.
  //
  // `capabilities` is the same tri-state the screens already read, and it is a FAIL-CLOSED
  // gate: `null` means the session probe has not succeeded — no mutation is operable until
  // one does — while `capabilityError` is what makes the difference between "checking" and
  // "the check failed" visible to the operator instead of leaving five dead controls
  // unexplained (§7.2; review round 5, B1).
  const capabilityError = session.error && !session.error.unauthorized
    ? session.error.message
    : null
  // §6.5: a payload from another engine may not carry `control` at all. That is still an
  // ANSWER — a viewer that granted nothing — so it reads `[]` (read-only, with the
  // `--control` advice that fixes it), never `null`. `?? null` folded it into "still
  // checking", which on an old server never resolves and never says what to do about it.
  // Home has read it this way since its own round 4; the shell had not caught up.
  const capabilities = session.data
    ? (Array.isArray(session.data.control) ? session.data.control : [])
    : null
  return (
    <ControlProvider
      capabilities={capabilities} capabilityError={capabilityError}
      // The probe is a one-shot, and with the gate failing closed a failed one disables
      // every mutation in the app. Home's Retry is the operator's way back to it.
      onRetryCapabilities={session.reload}
    >
    <div className="app">
      <IconSprite />
      <TopBar
        route={route.name} session={session.data}
        capabilities={capabilities} capabilityError={capabilityError}
      />
      <div className="shell-body">
        <RunRail activeRunId={activeRunId} />
        <main className="shell-main">
          {route.name === 'home' ? <Home /> : null}
          {/* `null` until the session route answers — and `null` means UNKNOWN, which every
              §7.2 gate treats as "not yet permitted" rather than as unrestricted (review
              round 1, M1; round 5, B1). */}
          {route.name === 'run'
            ? <Cockpit runId={route.runId} capabilities={capabilities} />
            : null}
          {route.name === 'agent'
            ? (
              <TranscriptRoute
                runId={route.runId}
                agentIndex={route.agentIndex}
                compare={route.compare}
                capabilities={capabilities}
              />
            )
            : null}
          {/* §2.6. This route rendered a `PendingScreen` until W15 — and its Playwright test
              asserted the placeholder's heading, which is exactly how an unbuilt screen
              shipped with a green suite. The test now asserts the run's real value. */}
          {route.name === 'result'
            ? (
              <ResultRoute
                runId={route.runId}
                capabilities={capabilities}
                capabilityError={capabilityError}
              />
            )
            : null}
          {route.name === 'notfound' ? <NotFound path={route.path} /> : null}
        </main>
      </div>
    </div>
    </ControlProvider>
  )
}

function TopBar(
  { route, session, capabilities, capabilityError }: {
    route: string
    session: Session | null
    /** The NORMALIZED set (§6.5), so the chip and the controls cannot disagree. */
    capabilities: readonly string[] | null
    capabilityError?: string | null
  },
) {
  return (
    <div className="topbar">
      <div className="brand">
        <span className="wm">flo<i>w</i>ition</span>
        <span className="v">viewer{session ? ` ${session.version}` : ''}</span>
      </div>
      <nav className="nav" aria-label="Primary">
        {/* `data-landing="runs"` marks the one navigation control that is mounted on EVERY
            route, which is what makes it usable as the interim focus destination while a
            route change is in flight (app/landing.ts). */}
        <a
          href={href.home()} data-landing="runs"
          {...(route === 'home' ? { 'aria-current': 'page' as const } : {})}
        >
          Runs
        </a>
      </nav>
      <div className="topbar-right">
        {/* §7.2's persistent "controls locked" chip. W12 widens W8b's read-only chip to the
            PARTIAL case: `--control=answer` alone leaves four mutations locked, and a
            viewer that says nothing about that is a viewer whose disabled Delete button has
            no explanation anywhere on the screen. An UNKNOWN set now also produces a chip —
            it disables every mutation, so the page owes the operator that sentence — but
            never the word "read-only" (see `lockedSummary`). */}
        <ControlsLockedChip
          capabilities={capabilities}
          capabilityError={capabilityError ?? null}
        />
        <button
          type="button" className="icb" aria-label="Toggle theme (d)"
          onClick={() => toggleTheme()}
        >
          <Icon name="sun" />
        </button>
      </div>
    </div>
  )
}

/**
 * §7.1.2: no token → paste one, or run `flowition viewer --print-url`. It never loops:
 * a rejected `t` has already been cleared from sessionStorage by the client.
 */
export function TokenGate(
  { onToken, reason }: { onToken: (t: string) => void; reason?: string },
) {
  const [value, setValue] = useState('')
  return (
    <div className="app">
      <IconSprite />
      <div className="gate">
        <div className="card gate-card">
          <h1>This viewer needs a token</h1>
          <p>
            Reads are authenticated because transcripts are exactly the secrets the run
            directory&apos;s <code>0700</code> mode protects. Paste the token from the URL the
            CLI printed, or print it again:
          </p>
          <div className="snippet">
            <span className="p">$</span><span>flowition viewer --print-url</span>
          </div>
          <form
            onSubmit={(e) => { e.preventDefault(); if (value.trim()) onToken(value.trim()) }}
          >
            <label className="vh" htmlFor="token">Read token</label>
            <input
              className="inp" id="token" value={value} autoComplete="off" spellCheck={false}
              placeholder="paste the token" onChange={(e) => setValue(e.target.value)}
            />
            <button className="btn primary lg" type="submit">Use token</button>
          </form>
          {reason ? <p className="dim micro err">{reason}</p> : null}
        </div>
      </div>
    </div>
  )
}

/*
 * `PendingScreen` — "an unbuilt route, named and linkable, never a blank frame" — lived here
 * from W8b to W14 and is GONE with W15's Result view: §2.2's grammar has no unbuilt route
 * left, and a placeholder component nothing renders is a place for the next one to hide. The
 * shipped one hid behind its own Playwright assertion for two review rounds.
 */

function NotFound({ path }: { path: string }) {
  return (
    <div className="pending-screen">
      <div className="empty">
        <Icon name="unknown" size={20} className="dim" />
        <h3>No such screen</h3>
        <p><span className="mono">{path}</span> does not match any route in §2.2&apos;s grammar.</p>
        <button className="btn" type="button" onClick={() => navigate(href.home())}>
          Back to runs
        </button>
      </div>
    </div>
  )
}
