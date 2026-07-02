import './style.css'

const initialError =
  new URLSearchParams(window.location.search).get('error') === '1'
    ? 'Invalid username or password.'
    : ''

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <main class="login-shell">
    <section class="login-card" aria-label="Hermes sign-in">
      <div class="brand">
        <div class="brand-mark" aria-hidden="true">H</div>
        <div>
          <p class="eyebrow">Hermes Agent</p>
          <h1>Sign in</h1>
        </div>
      </div>

      <p class="lede">Enter your credentials to access the agent.</p>

      <div id="login-error" class="error" role="alert" hidden></div>

      <form id="login-form" class="form" novalidate>
        <label>
          <span>Username</span>
          <input
            id="username"
            name="username"
            type="text"
            autocomplete="username"
            autocapitalize="none"
            autocorrect="off"
            spellcheck="false"
            required
          />
        </label>
        <label>
          <span>Password</span>
          <input
            id="password"
            name="password"
            type="password"
            autocomplete="current-password"
            required
          />
        </label>
        <button id="login-submit" class="primary" type="submit">Sign in</button>
      </form>

      <p class="footer">Your session is private and for agent use only.</p>
    </section>
  </main>
`

const form = document.querySelector<HTMLFormElement>('#login-form')!
const usernameInput = document.querySelector<HTMLInputElement>('#username')!
const passwordInput = document.querySelector<HTMLInputElement>('#password')!
const submitButton = document.querySelector<HTMLButtonElement>('#login-submit')!
const errorBox = document.querySelector<HTMLDivElement>('#login-error')!

if (initialError) showError(initialError)
usernameInput.focus()

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  hideError()

  const username = usernameInput.value.trim()
  const password = passwordInput.value

  if (!username || !password) {
    showError('Please enter your username and password.')
    return
  }

  setPending(true)

  try {
    const body = new URLSearchParams({ username, password })
    const response = await fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      redirect: 'manual',
    })

    const succeeded =
      response.type === 'opaqueredirect' ||
      response.status === 0 ||
      (response.status >= 300 && response.status < 400) ||
      response.ok

    if (succeeded) {
      window.location.assign('/sessions')
      return
    }

    if (response.status === 401 || response.status === 403) {
      showError('Invalid username or password.')
      passwordInput.value = ''
      passwordInput.focus()
      return
    }

    showError(`Sign-in failed (${response.status}). Please try again.`)
  } catch (error) {
    showError(error instanceof Error ? error.message : 'Sign-in failed. Please try again.')
  } finally {
    setPending(false)
  }
})

function setPending(pending: boolean) {
  submitButton.disabled = pending
  submitButton.textContent = pending ? 'Signing in…' : 'Sign in'
}

function showError(message: string) {
  errorBox.textContent = message
  errorBox.hidden = false
}

function hideError() {
  errorBox.textContent = ''
  errorBox.hidden = true
}
