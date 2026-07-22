<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Sign in — alliteration.</title>

<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">

<link rel="stylesheet" href="css/tokens.css">
<link rel="stylesheet" href="css/shell.css">

<style>
  /* Sign-in is the one screen with no rail and no header, so it carries a
     little layout of its own. Colors still come from tokens.css. */
  .login-wrap {
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 24px;
  }
  .login-card {
    width: 100%;
    max-width: 380px;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    box-shadow: var(--shadow-card);
    padding: 28px;
  }
  .login-brand { text-align: center; margin-bottom: 22px; }
  .login-brand .mark { width: 44px; height: 44px; margin: 0 auto 10px; display: block; }
  .login-title { font-size: 20px; font-weight: 800; letter-spacing: -.02em; }
  .login-title .dot { color: var(--accent); }
  .login-sub { font-size: 12.5px; color: var(--muted); margin-top: 3px; }

  .field { margin-bottom: 14px; }
  .field label {
    display: block;
    font-size: 11.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: .04em;
    color: var(--muted);
    margin-bottom: 5px;
  }
  .field input {
    width: 100%;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    padding: 10px 12px;
    font-family: inherit;
    font-size: 14px;
    color: var(--ink);
    background: var(--card);
  }
  .field input:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-tint);
  }
  .field .hint { font-size: 11.5px; color: var(--faint); margin-top: 4px; }

  .login-btn { width: 100%; padding: 11px; font-size: 14px; margin-top: 4px; }

  .msg {
    font-size: 12.5px;
    border-radius: var(--radius-sm);
    padding: 9px 11px;
    margin-bottom: 14px;
    display: none;
  }
  .msg.err { display: block; background: var(--danger-tint); color: var(--danger); }
  .msg.ok  { display: block; background: var(--success-tint); color: var(--success-dk); }

  .setup-note {
    background: var(--accent-tint);
    color: var(--accent-deep);
    font-size: 12.5px;
    border-radius: var(--radius-sm);
    padding: 10px 12px;
    margin-bottom: 18px;
    line-height: 1.5;
  }
</style>
</head>
<body data-app="hub">

<div class="login-wrap">
  <div class="login-card">
    <div class="login-brand">
      <svg class="mark" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144" aria-hidden="true"><path fill="#231F20" d="M143.68,65.19c-.93-9.91-3.92-19.57-8.79-28.26-7.27-12.98-18.37-23.43-31.79-29.88C94.65,2.99,85.7.68,76.24.12c-.52-.03-1.43-.07-2.72-.12h-3.04c-.62.03-1.24.06-1.86.08-7.29.34-14.33,1.73-21.09,4.18C29.16,10.9,14.2,24.85,6.25,42.6,2.56,50.84.51,59.51.08,68.61c-.03.62-.06,1.24-.08,1.87v3.05c.03.58.05,1.16.08,1.74.39,8.83,2.33,17.27,5.82,25.32,3.44,7.95,8.19,15.07,14.24,21.36,6.26,6.5,13.47,11.64,21.64,15.43,15.56,7.22,33.4,8.57,49.89,3.91,22.37-6.33,40.42-23.28,48.22-45.22,3.51-9.87,4.77-20.44,3.8-30.87Z"/><path fill="#52A246" d="M71.33,64.73c-4.38.35-7.65,4.14-7.3,8.46.35,4.32,4.18,7.54,8.56,7.18,4.38-.35,7.65-4.14,7.3-8.46-.35-4.32-4.18-7.54-8.56-7.18Z"/></svg>
      <div class="login-title">alliteration<span class="dot">.</span></div>
      <div class="login-sub" id="loginSub">P&amp;M Apparel</div>
    </div>

    <div id="setupNote" class="setup-note" hidden>
      No accounts exist yet. The first account you create is the administrator,
      and it is the only one that can add everyone else.
    </div>

    <div id="msg" class="msg"></div>

    <form id="loginForm">
      <div class="field">
        <label for="username">Username</label>
        <input id="username" name="username" autocomplete="username" required autofocus>
        <div class="hint" id="userHint" hidden>3-32 characters: letters, numbers, dot, dash, underscore</div>
      </div>

      <div class="field" id="nameField" hidden>
        <label for="name">Full name</label>
        <input id="name" name="name" autocomplete="name">
      </div>

      <div class="field">
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required>
        <div class="hint" id="pwHint" hidden>At least 8 characters</div>
      </div>

      <button type="submit" class="btn btn-accent login-btn" id="submitBtn">Sign in</button>
    </form>
  </div>
</div>

<script type="module">
  const form   = document.getElementById('loginForm');
  const msg    = document.getElementById('msg');
  const btn    = document.getElementById('submitBtn');
  const note   = document.getElementById('setupNote');
  const nameF  = document.getElementById('nameField');
  const sub    = document.getElementById('loginSub');
  const uHint  = document.getElementById('userHint');
  const pHint  = document.getElementById('pwHint');

  let mode = 'login';

  function show(text, kind) {
    msg.textContent = text;
    msg.className = 'msg ' + kind;
  }

  function setSetupMode() {
    mode = 'bootstrap';
    note.hidden = false;
    nameF.hidden = false;
    uHint.hidden = false;
    pHint.hidden = false;
    sub.textContent = 'Create the first account';
    btn.textContent = 'Create account';
    document.getElementById('password').setAttribute('autocomplete', 'new-password');
  }

  // Ask the server whether anyone has an account yet. If not, this becomes the
  // setup screen instead of the sign-in screen.
  try {
    const res = await fetch('/api/auth?action=session', { credentials: 'same-origin' });
    const data = await res.json();
    if (data.authenticated) {
      location.replace('/');
    } else if (data.needsSetup) {
      setSetupMode();
    }
  } catch (e) {
    show('Cannot reach the server. Check that storage is configured.', 'err');
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    btn.disabled = true;
    msg.className = 'msg';

    const payload = {
      action: mode,
      username: document.getElementById('username').value.trim(),
      password: document.getElementById('password').value,
    };
    if (mode === 'bootstrap') payload.name = document.getElementById('name').value.trim();

    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();

      if (!res.ok) {
        show(data.error || 'Sign in failed', 'err');
        btn.disabled = false;
        return;
      }

      show('Signed in. Loading...', 'ok');
      location.replace('/');
    } catch (err) {
      show('Network error. Try again.', 'err');
      btn.disabled = false;
    }
  });
</script>

</body>
</html>
