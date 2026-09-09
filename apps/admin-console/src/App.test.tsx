import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import App from './App.js';

/** T2.9 smoke: login gate renders; non-sys_admin login is rejected with a message. */
describe('admin console', () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('shows the login form with server/token flow', () => {
    render(<App />);
    expect(screen.getByTestId('admin-login')).toBeTruthy();
    expect(screen.getByTestId('admin-login-submit')).toBeTruthy();
  });

  it('rejects non-sys_admin with a message and stays on login', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ tokens: { accessToken: 'x', refreshToken: 'y' }, role: 'member', mustChangePassword: false }), { status: 200 })
    ) as typeof fetch;
    try {
      render(<App />);
      const form = screen.getByTestId('admin-login');
      (form.querySelector('input[name="username"]') as HTMLInputElement).value = 'someone';
      (form.querySelector('input[name="password"]') as HTMLInputElement).value = 'pw';
      fireEvent.submit(form);
      await screen.findByText(/仅系统管理员/);
      // still on the login screen
      expect(screen.getByTestId('admin-login')).toBeTruthy();
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
