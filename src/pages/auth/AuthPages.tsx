import { ArrowLeft, Eye, EyeOff, FlaskConical, KeyRound, LogOut, Mail, PlayCircle, ShieldCheck } from 'lucide-react'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { BrandMark } from '@/components/ui/BrandMark'
import { Button } from '@/components/ui/button'
import { Checkbox, Field, Input } from '@/components/ui/form'
import {
  clearFailures,
  FLASH_MESSAGES,
  lockoutRemaining,
  newPasswordProblem,
  recordFailure,
  takeFlash,
  validateSignIn,
} from '@/backend/authTypes'
import { isFirebaseConfigured } from '@/backend/firebase'
import { db, DEMO_ACCOUNTS, DEMO_PASSWORD, enterDemo, exitDemo, IS_DEMO } from '@/lib/backend'
import { errorMessage } from '@/lib/utils'
import { useAuth } from '@/providers/AuthProvider'

function AuthLayout({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[1.1fr_1fr]">
      <div className="relative hidden flex-col justify-between overflow-hidden bg-black p-10 text-white lg:flex">
        <div className="flex items-center gap-3">
          <BrandMark className="size-14" />
          <div>
            <p className="text-lg font-extrabold">
              ABC<span className="text-accent">kit</span>
            </p>
            <p className="text-[11px] uppercase tracking-[0.18em] text-white/60">Aricom Building Contractors Work Kit</p>
          </div>
        </div>
        <div className="max-w-md">
          <p className="text-4xl font-extrabold leading-[1.1] tracking-tight">
            Every project, cost and site report — <span className="text-accent">under control.</span>
          </p>
          <p className="mt-4 text-sm leading-relaxed text-white/65">
            Projects, BOQs, site operations, materials, procurement, plant, workforce and finance in one secure platform built for
            ARICOM BUILDING CONTRACTORS.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-white/50">
          <ShieldCheck className="size-4 text-accent" /> Role-based access · audit trail on every transaction
        </div>
        <div className="hazard-stripe absolute inset-x-0 bottom-0 h-2" />
      </div>
      <div className="flex items-center justify-center bg-background px-5 py-10">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <BrandMark className="size-12" />
            <div>
              <p className="text-lg font-extrabold leading-tight">
                ABC<span className="text-accent-ink">kit</span>
              </p>
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">Aricom Building Contractors</p>
            </div>
          </div>
          {IS_DEMO && (
            <p className="mb-4 inline-flex items-center gap-1.5 rounded-full bg-accent px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-black">
              <FlaskConical className="size-3.5" /> Demo mode
            </p>
          )}
          <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
          <div className="mt-6">{children}</div>
        </div>
      </div>
    </div>
  )
}

export function LoginPage() {
  const { isDemo } = useAuth()
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [touched, setTouched] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lockedMs, setLockedMs] = useState(0)
  const navigate = useNavigate()
  const location = useLocation()
  const from = (location.state as { from?: string } | null)?.from ?? '/'

  // one-shot message after sign-out / expiry (set before the page reloaded)
  useEffect(() => {
    const reason = takeFlash()
    if (!reason) return
    const m = FLASH_MESSAGES[reason]
    if (m.kind === 'success') toast.success(m.text)
    else if (m.kind === 'warning') toast.warning(m.text)
    else toast.info(m.text)
  }, [])

  // countdown while this identifier is throttled
  useEffect(() => {
    const tick = () => setLockedMs(identifier.trim() ? lockoutRemaining(identifier) : 0)
    tick()
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
  }, [identifier])

  const problem = validateSignIn(identifier, password)

  const signIn = async (id: string, pw: string) => {
    if (lockoutRemaining(id) > 0) return
    setBusy(true)
    setError(null)
    const { error } = await db.auth.signInWithPassword({ email: id.trim(), password: pw, remember })
    setBusy(false)
    if (error) {
      // count only credential failures (not network/config errors) towards the throttle
      if (/invalid-credential|wrong-password|user-not-found|invalid-login/.test(error.code)) {
        const { lockedForMs } = recordFailure(id)
        setLockedMs(lockedForMs)
      }
      setError(error.message)
      setPassword('')
      return
    }
    clearFailures(id)
    navigate(from === '/login' ? '/' : from, { replace: true })
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setTouched(true)
    if (problem) return
    await signIn(identifier, password)
  }

  const lockedSec = Math.ceil(lockedMs / 1000)

  const form = (
    <form onSubmit={submit} className="space-y-4" noValidate aria-busy={busy}>
      <Field label="Email or username" htmlFor="identifier" error={touched && problem && !identifier.trim() ? problem : undefined}>
        <Input
          id="identifier"
          type="text"
          inputMode="email"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          autoFocus
          maxLength={254}
          placeholder={isDemo ? 'e.g. demo.pm or pm@demo.abckit' : 'name@company.co.tz or username'}
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          aria-invalid={touched && !!problem && !identifier.trim()}
        />
      </Field>
      <Field label="Password" htmlFor="password" error={touched && problem && identifier.trim() ? problem : undefined}>
        <div className="relative">
          <Input
            id="password"
            type={show ? 'text' : 'password'}
            autoComplete="current-password"
            maxLength={256}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="pr-10"
            aria-invalid={touched && !!problem && !!identifier.trim()}
          />
          <button
            type="button"
            onClick={() => setShow((s) => !s)}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-subtle hover:text-foreground"
            aria-label={show ? 'Hide password' : 'Show password'}
            aria-pressed={show}
          >
            {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>
      </Field>
      <div className="flex items-center justify-between gap-3">
        <Checkbox label="Remember me" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        {!isDemo && (
          <Link to="/forgot-password" className="text-sm text-accent-ink hover:underline">
            Forgot password?
          </Link>
        )}
      </div>
      <p className="-mt-2 text-xs text-subtle">
        {remember ? 'Stay signed in on this device for up to 30 days.' : 'Signed out when the browser closes or after 30 minutes of inactivity.'}
      </p>
      {error && (
        <p role="alert" className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      {lockedMs > 0 && (
        <p role="status" className="rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-sm text-warning">
          Too many failed attempts. Try again in {lockedSec} s{isDemo ? '' : ', or reset your password'}.
        </p>
      )}
      <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} disabled={busy || lockedMs > 0}>
        {busy ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  )

  if (isDemo)
    return (
      <AuthLayout title="Demo sign-in" subtitle="Explore ABCkit with sample [DEMO] data. Pick a role — each sees only what its permissions allow.">
        <div className="mb-4 rounded-lg border border-warning/40 bg-warning-soft px-3 py-2 text-xs leading-relaxed text-warning">
          <strong>DEMO MODE — not secure.</strong> Data and demo accounts live only in this browser and nothing is sent to a server. Do not enter
          real company data. Every demo account uses the password <code className="font-mono font-semibold">{DEMO_PASSWORD}</code>.
        </div>
        <ul className="grid max-h-[42vh] gap-2 overflow-y-auto pr-1">
          {DEMO_ACCOUNTS.map((a) => (
            <li key={a.email}>
              <button
                disabled={busy}
                onClick={() => {
                  setIdentifier(a.username)
                  setPassword(DEMO_PASSWORD)
                  void signIn(a.username, DEMO_PASSWORD)
                }}
                className="flex w-full items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2.5 text-left transition-colors hover:border-accent hover:bg-accent-soft disabled:opacity-50"
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-bold text-black">
                  {a.name.split(' ').map((p) => p[0]).join('')}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold">{a.label}</span>
                  <span className="block truncate text-xs text-muted">
                    {a.name} · <span className="font-mono">{a.username}</span>
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        <details className="mt-4 rounded-lg border border-border px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium">Sign in with a demo email or username</summary>
          <div className="mt-3">{form}</div>
        </details>
        <button className="mt-4 text-sm text-accent-ink hover:underline" onClick={exitDemo}>
          Exit demo{isFirebaseConfigured ? ' and return to the company sign-in' : ''}
        </button>
      </AuthLayout>
    )

  return (
    <AuthLayout title="Sign in" subtitle="Use the account issued by your administrator.">
      {form}
      <div className="mt-8 border-t border-border pt-4 text-center">
        <p className="text-xs text-muted">Just exploring? The demo runs entirely in your browser with sample data.</p>
        <Button variant="ghost" className="mt-2" onClick={enterDemo}>
          <PlayCircle /> Try the demo
        </Button>
      </div>
    </AuthLayout>
  )
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    const redirectTo = `${window.location.origin}${window.location.pathname}#/reset-password`
    const { error } = await db.auth.resetPasswordForEmail(email.trim(), { redirectTo })
    setBusy(false)
    // Always show the same message so the form cannot be used to discover accounts
    if (error && !/rate limit/i.test(error.message)) console.warn(error)
    if (error && /rate limit/i.test(error.message)) toast.error('Too many requests — please wait a minute and try again.')
    else setSent(true)
  }

  return (
    <AuthLayout title="Reset password" subtitle="We'll email you a secure link to choose a new password.">
      {sent ? (
        <div className="rounded-lg border border-border bg-surface p-4 text-sm">
          <Mail className="mb-2 size-5 text-accent-ink" />
          If an account exists for <strong>{email}</strong>, a reset link is on its way. The link expires in one hour.
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <Field label="Email" htmlFor="email">
            <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>
            Send reset link
          </Button>
        </form>
      )}
      <Link to="/login" className="mt-6 inline-flex items-center gap-1 text-sm text-muted hover:text-foreground">
        <ArrowLeft className="size-4" /> Back to sign in
      </Link>
    </AuthLayout>
  )
}

export const passwordProblem = newPasswordProblem

export function ResetPasswordPage() {
  const { session } = useAuth()
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [busy, setBusy] = useState(false)
  const [ready, setReady] = useState(false)
  const navigate = useNavigate()

  useEffect(() => {
    const { data } = db.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY' || event === 'SIGNED_IN') setReady(true)
    })
    if (session) setReady(true)
    return () => data.subscription.unsubscribe()
  }, [session])

  const problem = pw ? passwordProblem(pw) : null
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (problem || pw !== pw2) return
    setBusy(true)
    const { error } = await db.auth.updateUser({ password: pw })
    setBusy(false)
    if (error) return toast.error(errorMessage(error))
    toast.success('Password updated')
    navigate('/', { replace: true })
  }

  return (
    <AuthLayout title="Choose a new password">
      {!ready ? (
        <p className="text-sm text-muted">
          Open this page from the link in your password reset email. If the link has expired, <Link to="/forgot-password" className="text-accent-ink underline">request a new one</Link>.
        </p>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <Field label="New password" htmlFor="pw" error={problem ?? undefined} hint="At least 10 characters with letters and numbers.">
            <Input id="pw" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
          </Field>
          <Field label="Confirm password" htmlFor="pw2" error={pw2 && pw !== pw2 ? 'Passwords do not match' : undefined}>
            <Input id="pw2" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
          </Field>
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} disabled={!pw || !!problem || pw !== pw2}>
            <KeyRound /> Update password
          </Button>
        </form>
      )}
    </AuthLayout>
  )
}

export function InactivePage() {
  const { signOut, profile, refresh } = useAuth()
  return (
    <AuthLayout title="Account pending activation">
      <p className="text-sm text-muted">
        {profile ? (
          <>
            Your account <strong className="text-foreground">{profile.email}</strong> exists but has not been activated, or has been deactivated.
            An administrator must activate it and assign a role before you can use ABCkit.
          </>
        ) : (
          'Your user profile could not be loaded.'
        )}
      </p>
      <div className="mt-6 flex gap-2">
        <Button onClick={() => refresh()}>Check again</Button>
        <Button variant="ghost" onClick={() => signOut()}>
          <LogOut /> Sign out
        </Button>
      </div>
    </AuthLayout>
  )
}

export function SetupRequiredPage() {
  return (
    <AuthLayout title="Configuration required" subtitle="ABCkit is not connected to Firebase yet.">
      <div className="space-y-3 text-sm text-muted">
        <p>
          Create a <code className="rounded bg-surface-2 px-1 font-mono text-xs">.env.local</code> file in the project root with your Firebase web-app
          configuration (Firebase console → Project settings → Your apps), then restart the dev server:
        </p>
        <pre className="overflow-x-auto rounded-lg bg-black p-3 font-mono text-xs text-white">
          {`VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=<project>.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=<project>
VITE_FIREBASE_STORAGE_BUCKET=<project>.firebasestorage.app
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...`}
        </pre>
        <p>See README → “Firebase setup”.</p>
      </div>
      <div className="mt-6 rounded-xl border border-accent/40 bg-accent-soft p-4">
        <p className="font-semibold text-foreground">Just want to look around?</p>
        <p className="mt-1 text-sm text-muted">Open the demo: the full app with sample [DEMO] data, running entirely in this browser.</p>
        <Button variant="primary" size="lg" className="mt-3 w-full" onClick={enterDemo}>
          <PlayCircle /> Open the demo
        </Button>
      </div>
    </AuthLayout>
  )
}
