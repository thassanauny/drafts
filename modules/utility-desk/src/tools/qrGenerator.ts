import { toolPage, group, outputPanel } from '../page';
import { h, field, input, select, option, taskControls, button, emptyState } from '../ui';
import { generateQr, buildQrPayload, QR_TYPES, type QrType, type QrValues, type QrLevel } from '../lib/qr';
import { downloadBlob, sanitizeFilename, throwIfAborted } from '../lib/util';

export function mount(root: HTMLElement) {
  const type = select('qrType', QR_TYPES, 'text');
  const text = h('textarea', { name: 'text', rows: 4, placeholder: 'https://example.com or any text', spellcheck: false });
  const ssid = input('text', 'ssid', '', { autocomplete: 'off', spellcheck: false });
  const security = select('security', [['WPA', 'WPA / WPA2 Personal'], ['WEP', 'WEP'], ['nopass', 'Open network (no password)']], 'WPA');
  const password = input('password', 'password', '', { autocomplete: 'new-password', spellcheck: false });
  const hidden = input('checkbox', 'hidden');
  const email = input('email', 'email', '', { placeholder: 'name@example.com' });
  const subject = input('text', 'subject');
  const body = h('textarea', { name: 'body', rows: 3 });
  const phone = input('tel', 'phone', '', { placeholder: '+66 81 234 5678' });
  const message = h('textarea', { name: 'message', rows: 3 });
  const firstName = input('text', 'firstName'), lastName = input('text', 'lastName'), organization = input('text', 'organization');
  const contactPhone = input('tel', 'contactPhone'), contactEmail = input('email', 'contactEmail');
  const website = input('url', 'website', '', { placeholder: 'https://example.com' });
  const passwordField = field('Wi-Fi password', password, 'Anyone with this QR code can read the password.');
  const sections: [QrType[], HTMLElement][] = [
    [['text'], h('div', {}, field('Text or URL', text, 'The exact text is encoded. Links are not opened or fetched.'))],
    [['wifi'], h('div', {}, field('Network name (SSID)', ssid, 'Enter the exact network name, including spaces and capitalization.'), field('Security', security), passwordField, option('Hidden network', 'Enable if the network does not broadcast its name.', hidden))],
    [['email'], h('div', {}, field('Email address', email), field('Subject (optional)', subject), field('Message (optional)', body))],
    [['phone', 'sms'], h('div', {}, field('Phone number', phone, 'Include the country code for use abroad.'))],
    [['sms'], h('div', {}, field('Message (optional)', message))],
    [['contact'], h('div', {}, h('div', { class: 'option-grid' }, field('First name', firstName), field('Last name', lastName)), field('Organization (optional)', organization), field('Phone (optional)', contactPhone), field('Email (optional)', contactEmail), field('Website (optional)', website))],
  ];
  const refreshFields = () => {
    sections.forEach(([types, section]) => { section.hidden = !types.includes(type.value as QrType); });
    passwordField.hidden = security.value === 'nopass';
    password.disabled = security.value === 'nopass';
  };
  refreshFields();
  const values = (): QrValues => ({ text: text.value, ssid: ssid.value, security: security.value, password: password.value, hidden: hidden.checked, email: email.value, subject: subject.value, body: body.value, phone: phone.value, message: message.value, firstName: firstName.value, lastName: lastName.value, organization: organization.value, contactPhone: contactPhone.value, contactEmail: contactEmail.value, website: website.value });
  const size = select('size', [256, 512, 1024, 2048].map((n) => [String(n), `${n} × ${n} pixels`]), '512');
  const level = select('level', [['L', 'Low · 7%'], ['M', 'Medium · 15%'], ['Q', 'High · 25%'], ['H', 'Highest · 30%']], 'M');
  const name = input('text', 'outName', 'qr-code');
  const results = h('div', { class: 'qr-result', 'aria-live': 'polite' }, emptyState('Your QR code will appear here', 'Choose a type, enter its details, then generate your code.'));
  const clear = () => results.replaceChildren(emptyState('Ready to generate', 'Generate a new code for your current details and settings.'));
  [type, text, ssid, security, password, hidden, email, subject, body, phone, message, firstName, lastName, organization, contactPhone, contactEmail, website, size, level, name].forEach((control) => {
    control.addEventListener('input', clear);
    control.addEventListener('change', clear);
  });
  type.addEventListener('change', refreshFields);
  security.addEventListener('change', refreshFields);
  const task = taskControls('qr-generator', 'Generate QR code', async ({ signal }) => {
    const result = await generateQr(buildQrPayload(type.value as QrType, values()), { size: Number(size.value), level: level.value as QrLevel });
    throwIfAborted(signal);
    const filename = sanitizeFilename(name.value.replace(/\.(png|svg)$/i, ''), 'qr-code');
    results.replaceChildren(h('img', { src: result.png, alt: 'Generated QR code', class: 'qr-preview', width: 256, height: 256 }),
      h('p', { class: 'field-hint' }, `${size.value} × ${size.value} pixels · Scan with your camera to check the content.`),
      h('div', { class: 'action-buttons' },
        button('Download PNG', () => { const bytes = Uint8Array.from(atob(result.png.split(',')[1]), (c) => c.charCodeAt(0)); downloadBlob(new Blob([bytes], { type: 'image/png' }), `${filename}.png`); }, { variant: 'primary' }),
        button('Download SVG', () => downloadBlob(new Blob([result.svg], { type: 'image/svg+xml' }), `${filename}.svg`))));
    return 'QR code ready.';
  }, { validate: () => { try { buildQrPayload(type.value as QrType, values()); return null; } catch (error) { return (error as Error).message; } } });
  toolPage(root, 'qr-generator', { config: [group(null, field('QR type', type, 'Details stay on this page and are not saved.'), ...sections.map(([, section]) => section), h('div', { class: 'option-grid' }, field('PNG size', size), field('Error correction', level, 'Higher levels tolerate more damage and fit less text.')), field('Output filename (without extension)', name))], actions: [task.el], output: [outputPanel('QR code', 'PREVIEW & DOWNLOAD', results)] });
  return () => { root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea').forEach((control) => { control.value = ''; }); results.replaceChildren(); };
}
