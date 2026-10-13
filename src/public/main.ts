// Public page: form, status card, localStorage token (plan §6).
import '../styles/tokens.css';
import '../styles/base.css';
import '../styles/public.css';
import { getMyRegistration, registerMember, type Registration } from './api';
import { cleanText, validateRegistration, type Field } from '../shared/phone';

const TOKEN_KEY = 'filo_reg_token';

const FIELD_MESSAGES: Record<Field, string> = {
  full_name: 'اكتب اسمك بالكامل (من حرفين لـ 100 حرف).',
  phone: 'اكتب رقم موبايل مصري صحيح، زي 01xxxxxxxxx.',
  faculty: 'اكتب اسم الكلية.',
  university: 'اكتب اسم الجامعة.',
};

const MSG_PHONE_TAKEN =
  'الرقم ده متسجل قبل كده. لو انت اللي سجلت ومش لاقي حالتك، كلّم المسؤولين عن الاجتماع.';
const MSG_RATE_LIMITED = 'محاولات كتير من نفس الشبكة. استنى دقيقة وحاول تاني.';
const MSG_BUSY = 'الضغط عالي، حاول تاني بعد لحظات';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const registerSection = $('register-section');
const form = $<HTMLFormElement>('register-form');
const formAlert = $('form-alert');
const submitBtn = $<HTMLButtonElement>('submit-btn');
const statusSection = $('status-section');

// ---------- localStorage (may throw in private modes) ----------
function loadToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function saveToken(token: string): boolean {
  try {
    localStorage.setItem(TOKEN_KEY, token);
    return localStorage.getItem(TOKEN_KEY) === token;
  } catch {
    return false;
  }
}

function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* nothing to clear */
  }
}

function newSubmissionId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ---------- Views ----------
function showForm(): void {
  document.documentElement.classList.remove('has-token');
  statusSection.hidden = true;
  registerSection.hidden = false;
}

function showStatusPart(part: 'loading' | 'error' | 'body'): void {
  document.documentElement.classList.remove('has-token');
  registerSection.hidden = true;
  statusSection.hidden = false;
  $('status-loading').hidden = part !== 'loading';
  $('status-error').hidden = part !== 'error';
  $('status-body').hidden = part !== 'body';
}

function renderStatus(reg: Registration, storageOk = true): void {
  $('member-name').textContent = reg.fullName;
  const confirmed = reg.status === 'confirmed';
  $('status-confirmed').hidden = !confirmed;
  $('status-waiting').hidden = confirmed;
  if (confirmed) {
    $('attendance-number').textContent = String(reg.attendanceNumber);
  } else {
    $('waiting-position').textContent = `#${reg.waitingPosition}`;
  }
  $('storage-warning').hidden = storageOk;
  showStatusPart('body');
}

// ---------- Returning member ----------
async function loadStatus(token: string): Promise<void> {
  showStatusPart('loading');
  try {
    const reg = await getMyRegistration(token);
    if (!reg) {
      clearToken();
      showForm();
      return;
    }
    renderStatus(reg);
  } catch {
    showStatusPart('error');
  }
}

$('status-retry').addEventListener('click', () => {
  const token = loadToken();
  if (token) void loadStatus(token);
  else showForm();
});

$('status-refresh').addEventListener('click', () => {
  const token = loadToken();
  if (token) void loadStatus(token);
});

// ---------- Registration form ----------
const submissionId = newSubmissionId();
const FIELDS: Field[] = ['full_name', 'phone', 'faculty', 'university'];

function input(field: Field | 'website'): HTMLInputElement {
  return form.elements.namedItem(field) as HTMLInputElement;
}

function setFieldError(field: Field, message: string | null): void {
  const el = $(`${field}-error`);
  el.textContent = message ?? '';
  el.hidden = !message;
  const inp = input(field);
  if (message) {
    inp.setAttribute('aria-invalid', 'true');
    inp.setAttribute('aria-describedby', el.id);
  } else {
    inp.removeAttribute('aria-invalid');
    inp.removeAttribute('aria-describedby');
  }
}

function setAlert(message: string | null): void {
  formAlert.textContent = message ?? '';
  formAlert.hidden = !message;
}

function setBusy(busy: boolean): void {
  submitBtn.disabled = busy;
  submitBtn.querySelector<HTMLElement>('.spinner')!.hidden = !busy;
  submitBtn.querySelector<HTMLElement>('.btn-label')!.textContent = busy ? 'جاري التسجيل…' : 'سجّل';
}

for (const field of FIELDS) {
  input(field).addEventListener('input', () => setFieldError(field, null));
}

let inFlight = false;

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (inFlight) return;

  setAlert(null);
  FIELDS.forEach((f) => setFieldError(f, null));

  const values = {
    fullName: input('full_name').value,
    phone: input('phone').value,
    faculty: input('faculty').value,
    university: input('university').value,
  };
  const invalid = validateRegistration(values);
  if (invalid) {
    setFieldError(invalid, FIELD_MESSAGES[invalid]);
    input(invalid).focus();
    return;
  }

  inFlight = true;
  setBusy(true);
  try {
    const res = await registerMember({
      p_full_name: cleanText(values.fullName),
      p_phone: values.phone,
      p_faculty: cleanText(values.faculty),
      p_university: cleanText(values.university),
      p_submission_id: submissionId,
      p_website: input('website').value,
    });

    switch (res.result) {
      case 'ok': {
        const stored = saveToken(res.token);
        renderStatus(res, stored);
        window.scrollTo({ top: statusSection.offsetTop - 16 });
        break;
      }
      case 'phone_taken':
        setFieldError('phone', MSG_PHONE_TAKEN);
        input('phone').focus();
        break;
      case 'invalid':
        if ((FIELDS as string[]).includes(res.field)) {
          setFieldError(res.field as Field, FIELD_MESSAGES[res.field as Field]);
          input(res.field as Field).focus();
        } else {
          setAlert(MSG_BUSY);
        }
        break;
      case 'rate_limited':
        setAlert(MSG_RATE_LIMITED);
        break;
    }
  } catch {
    // Everything the user typed stays in the form; the same submission_id is reused next time.
    setAlert(MSG_BUSY);
  } finally {
    inFlight = false;
    setBusy(false);
  }
});

// ---------- Start ----------
const savedToken = loadToken();
if (savedToken) {
  void loadStatus(savedToken);
} else {
  showForm(); // no network call for first-time visitors
}
