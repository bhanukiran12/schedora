import { fail } from './http.mjs';

// Server-side input validation. Each helper returns a normalized value or throws a 400 that
// names the field, so the client can attach the message to the right input.

const invalid = (field, message) => fail(400, 'validation_failed', message, { field });

export function text(value, field, { min = 0, max = 200, optional = false, multiline = false } = {}) {
  if (value == null || value === '') {
    if (optional || min === 0) return '';
    invalid(field, 'This field is required.');
  }
  if (typeof value !== 'string') invalid(field, 'Must be text.');
  let normalized = value.normalize('NFC').replace(/\r\n?/g, '\n');
  normalized = multiline ? normalized.trim() : normalized.replace(/\s+/g, ' ').trim();
  // Strip control characters other than newline and tab.
  normalized = normalized.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  if (normalized.length < min) invalid(field, min === 1 ? 'This field is required.' : `Use at least ${min} characters.`);
  if (normalized.length > max) invalid(field, `Use ${max} characters or fewer.`);
  return normalized;
}

const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
export function isEmail(value) {
  return typeof value === 'string' && value.length <= 254 && EMAIL.test(value);
}
export function email(value, field = 'email', { optional = false } = {}) {
  const normalized = text(value, field, { min: optional ? 0 : 1, max: 254 });
  if (!normalized && optional) return '';
  if (!isEmail(normalized)) invalid(field, 'Enter a valid email address.');
  return normalized.toLowerCase();
}

export function integer(value, field, min, max) {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isInteger(number) || number < min || number > max) invalid(field, `Enter a whole number from ${min} to ${max}.`);
  return number;
}

export function oneOf(value, field, allowed) {
  if (!allowed.includes(value)) invalid(field, 'Choose one of: ' + allowed.join(', ') + '.');
  return value;
}

export function bool(value, field) {
  if (typeof value !== 'boolean') invalid(field, 'Must be true or false.');
  return value;
}

export function slug(value, field = 'slug') {
  const normalized = text(value, field, { min: 2, max: 60 }).toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized)) invalid(field, 'Use lowercase letters, numbers and single hyphens.');
  return normalized;
}

export function slugify(value) {
  return String(value).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'item';
}

export function password(value, field = 'password') {
  if (typeof value !== 'string' || value.length < 10) invalid(field, 'Use at least 10 characters.');
  if (value.length > 200) invalid(field, 'Use 200 characters or fewer.');
  return value;
}

export { invalid };
