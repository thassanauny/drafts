import QRCode from 'qrcode';

export type QrLevel = 'L' | 'M' | 'Q' | 'H';
export interface QrOptions { size: number; level: QrLevel }
export const QR_TYPES: [QrType, string][] = [['text', 'Text or link'], ['wifi', 'Wi-Fi login'], ['email', 'Email'], ['phone', 'Phone call'], ['sms', 'SMS'], ['contact', 'Contact card']];
export type QrType = 'text' | 'wifi' | 'email' | 'phone' | 'sms' | 'contact';
export interface QrValues {
  text?: string; ssid?: string; security?: string; password?: string; hidden?: boolean;
  email?: string; subject?: string; body?: string; phone?: string; message?: string;
  firstName?: string; lastName?: string; organization?: string; contactPhone?: string; contactEmail?: string; website?: string;
}

function emailAddress(value: string) {
  const address = value.trim();
  if (!/^[^\s@<>;,?:#%]+@[^\s@<>;,?:#%]+\.[^\s@<>;,?:#%]+$/.test(address)) throw new Error('Enter a valid email address.');
  return address;
}
function phoneNumber(value: string) {
  const number = value.replace(/[ ().-]/g, '');
  if (!/^\+?[0-9]{1,20}$/.test(number)) throw new Error('Enter a phone number using digits and an optional + country code.');
  return number;
}
const wifiEscape = (value: string) => value.replace(/[\\;,:"]/g, (char) => `\\${char}`);
const cardEscape = (value: string) => value.replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/[;,]/g, '\\$&');
const hasControlCharacters = (value: string) => [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);

/** Build scanner-readable content without opening links or saving credentials. */
export function buildQrPayload(type: QrType, values: QrValues) {
  switch (type) {
    case 'text':
      if (!values.text?.trim()) throw new Error('Enter text or a URL for your QR code.');
      return values.text;
    case 'wifi': {
      const { ssid = '', password = '', security = 'WPA' } = values;
      if (!ssid.length) throw new Error('Enter the Wi-Fi network name (SSID).');
      if (hasControlCharacters(ssid) || (security !== 'nopass' && hasControlCharacters(password))) throw new Error('Wi-Fi names and passwords cannot contain control characters.');
      if (!['WPA', 'WEP', 'nopass'].includes(security)) throw new Error('Choose a supported Wi-Fi security type.');
      if (security !== 'nopass' && !password.length) throw new Error('Enter the Wi-Fi password, or choose an open network.');
      return `WIFI:T:${security};S:${wifiEscape(ssid)};${security === 'nopass' ? '' : `P:${wifiEscape(password)};`}H:${values.hidden ? 'true' : 'false'};;`;
    }
    case 'email': {
      const address = emailAddress(values.email ?? '');
      const query = [values.subject ? `subject=${encodeURIComponent(values.subject)}` : '', values.body ? `body=${encodeURIComponent(values.body)}` : ''].filter(Boolean).join('&');
      return `mailto:${address.split('@').map(encodeURIComponent).join('@')}${query ? `?${query}` : ''}`;
    }
    case 'phone': return `tel:${phoneNumber(values.phone ?? '')}`;
    case 'sms': return `sms:${phoneNumber(values.phone ?? '')}${values.message ? `?body=${encodeURIComponent(values.message)}` : ''}`;
    case 'contact': {
      const first = (values.firstName ?? '').trim(), last = (values.lastName ?? '').trim();
      if (!first && !last) throw new Error('Enter a first or last name for the contact.');
      const lines = ['BEGIN:VCARD', 'VERSION:3.0', `N:${cardEscape(last)};${cardEscape(first)};;;`, `FN:${cardEscape([first, last].filter(Boolean).join(' '))}`];
      if (values.organization?.trim()) lines.push(`ORG:${cardEscape(values.organization.trim())}`);
      if (values.contactPhone?.trim()) lines.push(`TEL:${phoneNumber(values.contactPhone)}`);
      if (values.contactEmail?.trim()) lines.push(`EMAIL:${cardEscape(emailAddress(values.contactEmail))}`);
      if (values.website?.trim()) {
        const website = values.website.trim();
        try { const url = new URL(website); if (!['http:', 'https:'].includes(url.protocol) || /\s/.test(website) || hasControlCharacters(website)) throw new Error(); }
        catch { throw new Error('Enter a website starting with http:// or https://.'); }
        lines.push(`URL:${website}`);
      }
      // vCard lines fold at 75 UTF-8 bytes without splitting a Unicode character.
      return [...lines, 'END:VCARD'].map((line) => {
        let result = '', bytes = 0;
        for (const char of line) {
          const length = new TextEncoder().encode(char).length;
          if (bytes + length > 75) { result += '\r\n '; bytes = 1; }
          result += char; bytes += length;
        }
        return result;
      }).join('\r\n') + '\r\n';
    }
    default: throw new Error('Choose a supported QR code type.');
  }
}

export function qrOptions(text: string, options: QrOptions) {
  if (!text.trim()) throw new Error('Enter text or a URL for your QR code.');
  if (new TextEncoder().encode(text).length > 2953) throw new Error('The text is too long. Use up to 2,953 UTF-8 bytes.');
  if (![256, 512, 1024, 2048].includes(options.size) || !['L', 'M', 'Q', 'H'].includes(options.level)) throw new Error('Choose a supported size and error correction level.');
  try { QRCode.create(text, { errorCorrectionLevel: options.level }); }
  catch { throw new Error('The text is too long for this error correction level. Shorten it or choose a lower level.'); }
  return { width: options.size, margin: 4, errorCorrectionLevel: options.level, color: { dark: '#000000ff', light: '#ffffffff' } };
}

export async function generateQr(text: string, options: QrOptions) {
  const settings = qrOptions(text, options);
  const svg = await QRCode.toString(text, { ...settings, type: 'svg' });
  const png = await QRCode.toDataURL(text, settings);
  return { svg, png };
}
