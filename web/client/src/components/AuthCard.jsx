import React, { useState } from 'react';

export default function AuthCard({
  authBusy,
  authError,
  onGoogleAuth,
  onEmailSignIn,
  onEmailSignUp,
  onClearError,
}) {
  const [mode, setMode] = useState('signin');
  const [form, setForm] = useState({
    name: '',
    email: '',
    password: '',
    phone: '',
    avatarUrl: '',
  });

  const isSignUp = mode === 'signup';

  function handleModeChange(nextMode) {
    setMode(nextMode);
    if (onClearError) onClearError();
  }

  function handleChange(field) {
    return (event) => {
      const { value } = event.target;
      setForm((prev) => ({ ...prev, [field]: value }));
    };
  }

  function handleSubmit(event) {
    event.preventDefault();
    if (authBusy) return;

    if (isSignUp) {
      onEmailSignUp({
        name: form.name,
        email: form.email,
        password: form.password,
        phone: form.phone,
        avatarUrl: form.avatarUrl,
      });
      return;
    }

    onEmailSignIn({
      email: form.email,
      password: form.password,
    });
  }

  return (
    <div className="auth-card" id="auth-card">
      <div className="auth-card-header">
        <span className="auth-kicker">KafkaChat</span>
        <h2>{isSignUp ? 'Create your account' : 'Welcome back'}</h2>
        <p>{isSignUp ? 'Start a new chat in seconds.' : 'Sign in to continue your conversations.'}</p>
      </div>

      <button
        type="button"
        className="auth-google-btn"
        onClick={onGoogleAuth}
        disabled={authBusy}
        aria-label="Continue with Google"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
          <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
          <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
          <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
        </svg>
        {authBusy ? 'Connecting...' : 'Continue with Google'}
      </button>

      <div className="auth-divider">
        <span>or use email</span>
      </div>

      <div className="auth-tabs" role="tablist" aria-label="Choose sign in mode">
        <button
          type="button"
          className={`auth-tab ${!isSignUp ? 'active' : ''}`}
          onClick={() => handleModeChange('signin')}
          aria-pressed={!isSignUp}
        >
          Sign in
        </button>
        <button
          type="button"
          className={`auth-tab ${isSignUp ? 'active' : ''}`}
          onClick={() => handleModeChange('signup')}
          aria-pressed={isSignUp}
        >
          Sign up
        </button>
      </div>

      <form className="auth-form" onSubmit={handleSubmit}>
        {isSignUp && (
          <div className="form-field">
            <label htmlFor="signup-name">Full name</label>
            <input
              id="signup-name"
              type="text"
              placeholder="Your name"
              autoComplete="name"
              value={form.name}
              onChange={handleChange('name')}
              required
            />
          </div>
        )}

        <div className="form-field">
          <label htmlFor="auth-email">Email address</label>
          <input
            id="auth-email"
            type="email"
            placeholder="you@example.com"
            autoComplete="email"
            value={form.email}
            onChange={handleChange('email')}
            required
          />
        </div>

        <div className="form-field">
          <label htmlFor="auth-password">Password</label>
          <input
            id="auth-password"
            type="password"
            placeholder="Enter your password"
            autoComplete={isSignUp ? 'new-password' : 'current-password'}
            value={form.password}
            onChange={handleChange('password')}
            required
          />
        </div>

        {isSignUp && (
          <div className="form-grid">
            <div className="form-field">
              <label htmlFor="signup-phone">Phone (optional)</label>
              <input
                id="signup-phone"
                type="tel"
                placeholder="+1 555 0123"
                autoComplete="tel"
                value={form.phone}
                onChange={handleChange('phone')}
              />
            </div>
            <div className="form-field">
              <label htmlFor="signup-avatar">Avatar URL (optional)</label>
              <input
                id="signup-avatar"
                type="url"
                placeholder="https://"
                autoComplete="url"
                value={form.avatarUrl}
                onChange={handleChange('avatarUrl')}
              />
            </div>
          </div>
        )}

        <button
          type="submit"
          className="auth-submit-btn"
          disabled={authBusy}
        >
          {authBusy
            ? (isSignUp ? 'Creating account...' : 'Signing in...')
            : (isSignUp ? 'Create account' : 'Sign in')}
        </button>
      </form>

      {authError && <div className="auth-error" role="alert">{authError}</div>}
    </div>
  );
}
