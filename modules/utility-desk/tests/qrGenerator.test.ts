import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '../src/tools/qrGenerator';
import { generateQr } from '../src/lib/qr';

vi.mock('../src/lib/qr', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/qr')>(),
  generateQr: vi.fn(async () => ({ png: 'data:image/png;base64,AA==', svg: '<svg></svg>' })),
}));

afterEach(() => { vi.clearAllMocks(); localStorage.clear(); document.body.replaceChildren(); });

function page() {
  document.body.innerHTML = '<main></main>';
  const root = document.querySelector('main')!;
  const cleanup = mount(root);
  const control = (name: string) => root.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[name="${name}"]`)!;
  const change = (name: string, value: string) => { const el = control(name); el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })); };
  const generate = () => (root.querySelector('.task .btn-primary') as HTMLButtonElement).click();
  return { root, cleanup, control, change, generate };
}

describe('QR type form', () => {
  it('shows fields for each type and hides the password on open networks', () => {
    const { control, change } = page();
    expect((control('qrType') as HTMLSelectElement).options.length).toBe(6);
    for (const [type, fields] of [['text', ['text']], ['wifi', ['ssid', 'password']], ['email', ['email', 'subject', 'body']], ['phone', ['phone']], ['sms', ['phone', 'message']], ['contact', ['firstName', 'lastName', 'organization']]] as const) {
      change('qrType', type);
      const shown = new Set<string>(fields);
      for (const name of ['text', 'ssid', 'email', 'phone', 'message', 'firstName']) expect(!!control(name).closest('[hidden]')).toBe(!shown.has(name));
    }
    change('qrType', 'wifi'); change('security', 'nopass');
    expect(control('password').disabled).toBe(true);
    expect(control('password').closest('[hidden]')).toBeTruthy();
    change('security', 'WPA');
    expect(control('password').disabled).toBe(false);
    expect(control('password').closest('[hidden]')).toBeNull();
  });

  it('validates Wi-Fi fields, generates the selected payload, clears stale results and never persists credentials', async () => {
    const { root, control, change, generate, cleanup } = page();
    change('qrType', 'wifi'); generate();
    expect(root.querySelector('.task [role="status"]')!.textContent).toContain('network name');
    expect(generateQr).not.toHaveBeenCalled();
    change('ssid', 'Guest;ไทย'); generate();
    expect(root.querySelector('.task [role="status"]')!.textContent).toContain('password');
    change('password', 'private-fixture');
    (control('hidden') as HTMLInputElement).checked = true;
    generate();
    await vi.waitFor(() => expect(root.querySelector('.qr-preview')).toBeTruthy());
    expect(generateQr).toHaveBeenCalledWith('WIFI:T:WPA;S:Guest\\;ไทย;P:private-fixture;H:true;;', { size: 512, level: 'M' });
    expect(JSON.stringify(localStorage)).not.toContain('private-fixture');
    change('qrType', 'email');
    expect(root.querySelector('.qr-preview')).toBeNull();
    change('qrType', 'wifi'); change('security', 'nopass'); generate();
    await vi.waitFor(() => expect(root.querySelector('.qr-preview')).toBeTruthy());
    expect(generateQr).toHaveBeenLastCalledWith('WIFI:T:nopass;S:Guest\\;ไทย;H:true;;', { size: 512, level: 'M' });
    cleanup();
    expect(control('password').value).toBe('');
    expect(JSON.stringify(localStorage)).not.toContain('Guest');
  });
});
