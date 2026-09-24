// Plain browser JavaScript, no build step. Stands in for the AEM Form UI.

const DRAFT_KEY = 'forms-prototype-draft';
const POLL_INTERVAL_MS = 2000;
const FINAL_STATUSES = ['COMPLETED', 'FAILED'];

const $ = (id) => document.getElementById(id);
let apiUrl;
let formDefinition;

async function init() {
  // `npm run deploy` writes the stack outputs (including the API URL) here.
  const outputs = await fetch('cdk-outputs.json').then((r) => r.json());
  apiUrl = outputs.FormsPrototype.ApiUrl;

  formDefinition = await fetch(`${apiUrl}/config`).then((r) => r.json());
  renderForm(formDefinition);
  restoreDraft();
}

function renderForm(definition) {
  $('form-title').textContent = definition.title;
  const container = $('fields');

  for (const field of definition.fields) {
    const wrapper = document.createElement('div');
    wrapper.className = 'field';
    wrapper.dataset.name = field.name;

    const label = document.createElement('label');
    label.htmlFor = field.name;
    label.textContent = field.label + (field.required ? ' *' : '');

    let input;
    if (field.type === 'file') {
      wrapper.append(label, ...createFileInput(field));
      container.append(wrapper);
      continue;
    } else if (field.type === 'select') {
      input = document.createElement('select');
      input.append(new Option('Please choose…', ''));
      for (const option of field.options) input.append(new Option(option.label, option.value));
    } else if (field.type === 'textarea') {
      input = document.createElement('textarea');
    } else {
      input = document.createElement('input');
      input.type = field.type;
    }
    input.id = input.name = field.name;
    if (field.maxLength) input.maxLength = field.maxLength;

    const error = document.createElement('p');
    error.className = 'error';

    wrapper.append(label, input, error);
    container.append(wrapper);
  }

  $('form').hidden = false;
}

// --- File upload -------------------------------------------------------------
// The file goes straight from the browser to S3. Our API only hands out a
// short-lived, signed permission to upload one specific object. The hidden
// input then carries the resulting S3 key into the normal form submit.

let uploadsInProgress = 0;

function createFileInput(field) {
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.id = field.name;
  picker.accept = field.accept.join(',');

  const keyInput = document.createElement('input');
  keyInput.type = 'hidden';
  keyInput.name = field.name;

  const info = document.createElement('p');
  info.className = 'hint';

  const error = document.createElement('p');
  error.className = 'error';

  picker.addEventListener('change', async () => {
    keyInput.value = '';
    error.textContent = info.textContent = '';
    const file = picker.files[0];
    if (!file) return;

    // Quick checks for good UX. The signed upload policy enforces them in S3.
    if (!field.accept.includes(file.type)) {
      error.textContent = 'This file type is not allowed';
      return;
    }
    if (file.size > field.maxSizeBytes) {
      error.textContent = `File must be at most ${field.maxSizeBytes / 1024 / 1024} MB`;
      return;
    }

    uploadsInProgress++;
    info.textContent = 'Uploading…';
    try {
      keyInput.value = await uploadFile(field.name, file);
      info.textContent = `Uploaded ${file.name} (${Math.ceil(file.size / 1024)} KB)`;
    } catch (err) {
      info.textContent = '';
      error.textContent = err.message;
    } finally {
      uploadsInProgress--;
    }
  });

  return [picker, keyInput, info, error];
}

async function uploadFile(fieldName, file) {
  // 1. Ask our API for a presigned POST for this file.
  const response = await fetch(`${apiUrl}/uploads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ field: fieldName, fileName: file.name, contentType: file.type, size: file.size }),
  });
  const presigned = await response.json();
  if (!response.ok) throw new Error(presigned.error ?? 'Could not start upload');

  // 2. Send the file directly to S3: the signed fields first, the file last.
  const body = new FormData();
  for (const [name, value] of Object.entries(presigned.fields)) body.append(name, value);
  body.append('file', file);

  const upload = await fetch(presigned.url, { method: 'POST', body });
  if (!upload.ok) throw new Error(`Upload rejected by S3 (${upload.status})`);

  return presigned.key;
}

// --- Local draft (the "optional local form draft" box in the diagram) ------

function readForm() {
  return Object.fromEntries(new FormData($('form')));
}

function saveDraft() {
  // Files can't be stored in a draft, so leave file fields out.
  const draft = readForm();
  for (const field of formDefinition.fields) if (field.type === 'file') delete draft[field.name];
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch { /* storage unavailable */ }
}

function restoreDraft() {
  let draft = {};
  try { draft = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? '{}'); } catch { /* ignore */ }
  for (const [name, value] of Object.entries(draft)) {
    const input = $('form').elements[name];
    if (input) input.value = value;
  }
}

function clearDraft() {
  try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
}

function resetForm() {
  $('form').reset();
  // reset() doesn't clear hidden inputs or our upload messages.
  for (const input of $('form').querySelectorAll('input[type=hidden]')) input.value = '';
  for (const hint of $('fields').querySelectorAll('.hint, .error')) hint.textContent = '';
  showErrors({});
}

// --- Validation and submit -------------------------------------------------

function showErrors(errors) {
  for (const wrapper of document.querySelectorAll('.field')) {
    const message = errors[wrapper.dataset.name] ?? '';
    wrapper.classList.toggle('invalid', Boolean(message));
    wrapper.querySelector('.error:last-child').textContent = message;
  }
}

// Quick frontend check for good UX. The server validates again regardless.
function validateLocally(data) {
  const errors = {};
  for (const field of formDefinition.fields) {
    if (field.required && !data[field.name]?.trim()) errors[field.name] = 'This field is required';
  }
  return errors;
}

async function submit(event) {
  event.preventDefault();
  $('form-error').textContent = '';

  if (uploadsInProgress > 0) {
    $('form-error').textContent = 'Please wait for the upload to finish';
    return;
  }

  const data = readForm();
  const localErrors = validateLocally(data);
  showErrors(localErrors);
  if (Object.keys(localErrors).length > 0) return;

  const button = $('form').querySelector('button[type=submit]');
  button.disabled = true;
  try {
    const response = await fetch(`${apiUrl}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
    });
    const body = await response.json();

    if (!response.ok) {
      showErrors(body.fields ?? {});
      $('form-error').textContent = body.error ?? `Request failed (${response.status})`;
      return;
    }

    clearDraft();
    showResult(body.submissionId);
  } catch (err) {
    $('form-error').textContent = `Network error: ${err.message}`;
  } finally {
    button.disabled = false;
  }
}

// --- Status polling ----------------------------------------------------------

function showResult(submissionId) {
  $('form').hidden = true;
  $('result').hidden = false;
  $('submission-id').textContent = submissionId;
  pollStatus(submissionId);
}

async function pollStatus(submissionId) {
  const status = await fetch(`${apiUrl}/status/${submissionId}`).then((r) => r.json());

  $('status').textContent = status.status;
  $('history').replaceChildren(
    ...status.history.map((h) => {
      const li = document.createElement('li');
      li.textContent = `${new Date(h.at).toLocaleTimeString()} ${h.status}${h.note ? ` (${h.note})` : ''}`;
      return li;
    }),
  );

  // Keep polling until the workflow finishes (give up after 2 minutes).
  if (!FINAL_STATUSES.includes(status.status) && Date.now() - pollStatus.startedAt < 120_000) {
    setTimeout(() => pollStatus(submissionId), POLL_INTERVAL_MS);
  }
}

$('form').addEventListener('input', saveDraft);
$('form').addEventListener('submit', (event) => {
  pollStatus.startedAt = Date.now();
  submit(event);
});
$('clear-draft').addEventListener('click', () => {
  clearDraft();
  resetForm();
});
$('new-submission').addEventListener('click', () => {
  resetForm();
  $('result').hidden = true;
  $('form').hidden = false;
});

init().catch((err) => {
  $('form-title').textContent = 'Could not load the form';
  console.error(err);
});
