/**
 * Login page controller.
 *
 * Rules implemented here:
 *  - If a session already exists, the operator is sent straight to the app.
 *  - Errors come only from the server; the inline box never invents success.
 *  - 401 / 423 / 429 / 422 each get distinct, accurate wording.
 *  - No credential is ever logged or stored.
 */
(() => {
  const form = document.getElementById('form');
  const errBox = document.getElementById('err');
  const submit = document.getElementById('submit');

  function showErr(message) {
    errBox.textContent = message;
    errBox.classList.add('is-on');
  }
  function clearErr() {
    errBox.textContent = '';
    errBox.classList.remove('is-on');
  }

  // Already signed in? Go straight to the console.
  SS.me()
    .then(() => { location.href = 'index.html'; })
    .catch(() => { /* not signed in — stay here */ });

  // Backend reachability indicator (public endpoint, no credentials).
  SS.health()
    .then((h) => {
      const el = document.getElementById('health');
      const txt = document.getElementById('health-text');
      el.hidden = false;
      if (h?.status === 'ok') txt.textContent = 'API online';
      else {
        el.classList.add('is-bad');
        txt.textContent = 'API degraded';
      }
    })
    .catch(() => {
      const el = document.getElementById('health');
      el.hidden = false;
      el.classList.add('is-bad');
      document.getElementById('health-text').textContent = 'API unreachable';
    });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErr();

    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;

    // Client-side validation is for usability only; the server is authoritative.
    if (!email || !password) {
      showErr('Enter both an email address and a password.');
      return;
    }

    submit.disabled = true;
    submit.textContent = 'Signing in…';
    try {
      await SS.login(email, password);
      // Server confirmed the session (cookies are set httpOnly). Only now may we
      // treat this as a success.
      location.href = 'index.html';
    } catch (err) {
      if (err.status === 423) showErr('This account is temporarily locked after too many failed attempts. Try again shortly.');
      else if (err.status === 429) showErr('Too many attempts. Please wait a moment and try again.');
      else if (err.status === 422) showErr(err.message || 'Please check the email address and password.');
      else if (err.status === 401) showErr('Incorrect email or password.');
      else if (err.status === 0) showErr('Cannot reach the API. Is the backend running?');
      else showErr(SS.describe(err));
      submit.disabled = false;
      submit.textContent = 'Sign in';
    }
  });
})();
