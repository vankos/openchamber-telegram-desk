'use strict';

const crypto = require('node:crypto');

const { encodeCallback } = require('./callback-data');
const { randomRef } = require('./ids');
const {
  escapeHtml,
  clip,
  clipHtmlSafe,
  htmlToPlain,
  sessionTitle,
} = require('./format');

const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'multiselect', 'external']);

const sanitizeWhen = (value) => {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 10).map((condition) => {
    if (!condition || typeof condition !== 'object') return null;
    const key = typeof condition.key === 'string' ? condition.key.slice(0, 100) : '';
    const op = condition.op === 'neq' ? 'neq' : 'eq';
    const raw = condition.value;
    if (!key) return null;
    if (!['string', 'number', 'boolean'].includes(typeof raw)) return null;
    return { key, op, value: raw };
  }).filter(Boolean);
};

const sanitizeField = (field, index) => {
  if (!field || typeof field !== 'object') return null;
  const key = typeof field.key === 'string' && field.key.trim() ? field.key.slice(0, 100) : `field_${index + 1}`;
  const type = TYPES.has(field.type) ? field.type : 'string';
  const options = Array.isArray(field.options)
    ? field.options.slice(0, 32).map((option) => {
      if (!option || typeof option !== 'object') return null;
      const value = String(option.value ?? '').slice(0, 200);
      const label = String(option.label ?? option.value ?? '').slice(0, 200);
      if (!value) return null;
      return { value, label };
    }).filter(Boolean)
    : [];
  return {
    key,
    type,
    title: clip(field.title ?? key, 300) || key,
    description: field.description ? clip(field.description, 500) : null,
    required: field.required === true,
    options,
    custom: field.custom === true,
    when: sanitizeWhen(field.when),
  };
};

const createFormState = ({ sessionId, sessionTitle: title, chatId = null }, ask) => {
  const fields = Array.isArray(ask?.fields)
    ? ask.fields.slice(0, 20).map(sanitizeField).filter(Boolean)
    : [];
  const now = Date.now();
  return {
    sessionId,
    formId: ask?.id,
    title: clip(ask?.title ?? 'Question', 300) || 'Question',
    sessionTitle: title ?? null,
    chatId,
    messageId: null,
    fields,
    answers: {},
    salt: randomRef(8),
    closed: false,
    createdAt: now,
    updatedAt: now,
  };
};

const formKey = (sessionId, formId) => `${sessionId}:${formId}`;

const normalizeConditionValue = (value) => {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  return String(value ?? '');
};

const conditionMatches = (condition, answers) => {
  if (!Object.prototype.hasOwnProperty.call(answers, condition.key)) return false;
  const answer = answers[condition.key];
  if (Array.isArray(answer)) {
    const values = answer.map(normalizeConditionValue);
    const target = normalizeConditionValue(condition.value);
    return condition.op === 'eq' ? values.includes(target) : !values.includes(target);
  }
  const actual = normalizeConditionValue(answer);
  const target = normalizeConditionValue(condition.value);
  return condition.op === 'eq' ? actual === target : actual !== target;
};

const visibleFields = (form) => (form.fields ?? []).filter(
  (field) => (field.when ?? []).every((condition) => conditionMatches(condition, form.answers ?? {})),
);

const findField = (form, key) => visibleFields(form).find((field) => field.key === key) ?? null;

const isAnswered = (field, answers) => {
  if (!Object.prototype.hasOwnProperty.call(answers, field.key)) return false;
  const value = answers[field.key];
  if (field.type === 'multiselect') return Array.isArray(value) && value.length > 0;
  if (field.type === 'boolean') return typeof value === 'boolean';
  if (field.type === 'number' || field.type === 'integer') return Number.isFinite(value);
  if (field.type === 'external') return false;
  return typeof value === 'string' ? value.trim().length > 0 : value !== null && value !== undefined;
};

const isComplete = (form) => {
  const fields = visibleFields(form);
  if (fields.some((field) => field.required && field.type === 'external')) return false;
  return fields.every((field) => !field.required || isAnswered(field, form.answers));
};

const nextTextField = (form) => visibleFields(form).find((field) => (
  field.type !== 'external'
  && !isAnswered(field, form.answers)
  && (
    (field.type === 'string' && field.options.length === 0)
    || field.type === 'number'
    || field.type === 'integer'
    || (field.type === 'multiselect' && (field.custom || field.options.length === 0))
  )
)) ?? null;

const dropHiddenAnswers = (form) => {
  const keys = new Set(visibleFields(form).map((field) => field.key));
  for (const key of Object.keys(form.answers)) {
    if (!keys.has(key)) delete form.answers[key];
  }
};

const applyChoice = (form, fieldKey, value) => {
  const field = findField(form, fieldKey);
  if (!field) return { ok: false, error: 'This field is no longer open.' };
  const option = field.options.find((item) => item.value === value);
  if (!option) return { ok: false, error: 'Unknown option.' };
  if (field.type === 'multiselect') {
    const current = Array.isArray(form.answers[fieldKey]) ? [...form.answers[fieldKey]] : [];
    const index = current.indexOf(value);
    if (index === -1) current.push(value);
    else current.splice(index, 1);
    form.answers[fieldKey] = current;
  } else if (field.type === 'boolean') {
    form.answers[fieldKey] = value === 'true' || value === 'yes' || value === '1';
  } else {
    form.answers[fieldKey] = value;
  }
  dropHiddenAnswers(form);
  form.updatedAt = Date.now();
  return { ok: true, field, option };
};

const parseTextValue = (field, text) => {
  const raw = String(text ?? '').trim();
  if (!raw) return { ok: false, error: 'The value is empty.' };
  if (field.type === 'external') return { ok: false, error: 'This field can only be answered in OpenChamber.' };
  if (field.type === 'number' || field.type === 'integer') {
    const numeric = raw.replace(',', '.');
    if (field.type === 'integer' && !/^-?\d+$/.test(numeric)) return { ok: false, error: 'Enter a whole number.' };
    const value = Number(numeric);
    if (!Number.isFinite(value)) return { ok: false, error: 'Enter a number.' };
    if (field.type === 'integer' && !Number.isInteger(value)) return { ok: false, error: 'Enter a whole number.' };
    return { ok: true, value };
  }
  if (field.type === 'boolean') {
    const normalized = raw.toLowerCase();
    if (['yes', 'y', 'true', '1'].includes(normalized)) return { ok: true, value: true };
    if (['no', 'n', 'false', '0'].includes(normalized)) return { ok: true, value: false };
    return { ok: false, error: 'Answer yes or no.' };
  }
  if (field.type === 'multiselect') {
    const parts = raw.split(/[\n,]+/).map((part) => part.trim()).filter(Boolean).slice(0, 30);
    const values = [];
    for (const part of parts) {
      const match = field.options.find((option) => option.value === part || option.label.toLowerCase() === part.toLowerCase());
      if (match) values.push(match.value);
      else if (field.custom) values.push(part.slice(0, 200));
      else return { ok: false, error: `Unknown value: ${part}` };
    }
    return { ok: true, value: [...new Set(values)] };
  }
  if (field.options.length > 0) {
    const match = field.options.find((option) => option.value === raw || option.label.toLowerCase() === raw.toLowerCase());
    if (!match) return { ok: false, error: 'Choose one of the options above.' };
    return { ok: true, value: match.value };
  }
  return { ok: true, value: clip(raw, 2000) };
};

const applyText = (form, fieldKey, text) => {
  const field = findField(form, fieldKey);
  if (!field) return { ok: false, error: 'This field is no longer open.' };
  const parsed = parseTextValue(field, text);
  if (!parsed.ok) return parsed;
  form.answers[fieldKey] = parsed.value;
  dropHiddenAnswers(form);
  form.updatedAt = Date.now();
  return { ok: true, field };
};

const answerLabel = (field, value) => {
  if (Array.isArray(value)) {
    return value.map((item) => field.options.find((option) => option.value === item)?.label ?? item).join(', ');
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (field.options.length) return field.options.find((option) => option.value === value)?.label ?? String(value);
  return String(value);
};

const answersForSubmit = (form) => {
  const out = {};
  for (const field of visibleFields(form)) {
    if (!isAnswered(field, form.answers)) continue;
    out[field.key] = form.answers[field.key];
  }
  return out;
};

const buttonLabel = (value, max = 40) => clip(value, max).replace(/\s+/g, ' ').trim() || 'Option';

const refFor = (form, kind, suffix) => {
  const hash = crypto.createHash('sha256').update(`${form.salt}:${kind}:${suffix}`).digest('hex');
  return hash.slice(0, 12);
};

const buildQuestionRefs = (form, field, option) => ({
  kind: 'question',
  sessionId: form.sessionId,
  formId: form.formId,
  fieldKey: field.key,
  value: option.value,
  label: option.label,
});

const renderForm = (form) => {
  if (!form.salt) form.salt = randomRef(8);
  const refs = [];
  const keyboard = [];
  const fields = visibleFields(form);
  const maxButtons = 40;
  const choiceFieldCount = fields.filter((field) => field.options.length > 0 || field.type === 'boolean').length;
  let buttonCount = 0;
  let optionsCapped = false;
  const lines = [
    `❓ <b>${escapeHtml(sessionTitle(form.sessionTitle, form.sessionId))}</b>`,
    `<b>${escapeHtml(form.title)}</b>`,
    '',
  ];
  for (const field of fields) {
    const answered = isAnswered(field, form.answers);
    const marker = answered ? '✓' : '○';
    const required = field.required ? ' <i>(required)</i>' : '';
    lines.push(`${marker} <b>${escapeHtml(field.title)}</b>${required}`);
    if (field.description) lines.push(`   <i>${escapeHtml(field.description)}</i>`);
    if (answered) {
      lines.push(`   <b>${escapeHtml(answerLabel(field, form.answers[field.key]))}</b>`);
    } else if (field.type === 'external') {
      lines.push('   <i>Only in OpenChamber — this field cannot be answered from Telegram.</i>');
    } else if (field.options.length > 0) {
      lines.push(field.type === 'multiselect'
        ? '   <i>Choose any number, then Submit.</i>'
        : '   <i>Choose below.</i>');
    } else if (field.type === 'boolean') {
      lines.push('   <i>Choose yes or no.</i>');
    } else {
      lines.push('   <i>Reply to this message with a value.</i>');
    }
  }
  if (!fields.length) lines.push('<i>This form has no answerable fields.</i>');

  for (const field of fields) {
    if (field.type === 'external') continue;
    const answered = isAnswered(field, form.answers);
    if (field.type === 'boolean') {
      for (const [value, label] of [['true', 'Yes'], ['false', 'No']]) {
        if (buttonCount >= maxButtons) {
          optionsCapped = true;
          break;
        }
        const ref = refFor(form, 'q', `${field.key}:${value}`);
        const selected = answered && form.answers[field.key] === (value === 'true');
        refs.push({ ref, payload: buildQuestionRefs(form, field, { value, label }) });
        const prefix = choiceFieldCount > 1 ? `${buttonLabel(field.title, 14)}: ` : '';
        keyboard.push([{ text: `${selected ? '✓ ' : ''}${prefix}${label}`, callback_data: encodeCallback('q', ref) }]);
        buttonCount += 1;
      }
      continue;
    }
    if (field.options.length > 0) {
      const remaining = Math.max(0, maxButtons - buttonCount);
      const options = field.options.slice(0, remaining);
      if (options.length < field.options.length) optionsCapped = true;
      const buttons = options.map((option) => {
        const ref = refFor(form, 'q', `${field.key}:${option.value}`);
        const selected = Array.isArray(form.answers[field.key])
          ? form.answers[field.key].includes(option.value)
          : form.answers[field.key] === option.value;
        refs.push({ ref, payload: buildQuestionRefs(form, field, option) });
        buttonCount += 1;
        const prefix = choiceFieldCount > 1 ? `${buttonLabel(field.title, 14)}: ` : '';
        return { text: `${selected ? '✓ ' : ''}${prefix}${buttonLabel(option.label, 40)}`, callback_data: encodeCallback('q', ref) };
      });
      for (let index = 0; index < buttons.length; index += 2) {
        keyboard.push(buttons.slice(index, index + 2));
      }
    }
  }

  if (optionsCapped) lines.push('', '<i>Some options fit only in OpenChamber.</i>');

  if (isComplete(form)) {
    const ref = refFor(form, 'submit', '');
    refs.push({ ref, payload: { kind: 'submit', sessionId: form.sessionId, formId: form.formId } });
    keyboard.push([{ text: '✅ Submit answer', callback_data: encodeCallback('s', ref) }]);
  }

  const dismissRef = refFor(form, 'dismiss', '');
  refs.push({ ref: dismissRef, payload: { kind: 'dismiss', sessionId: form.sessionId, formId: form.formId } });
  keyboard.push([{ text: '✖ Dismiss', callback_data: encodeCallback('x', dismissRef) }]);

  const text = clipHtmlSafe(lines.join('\n'));
  return { text, plain: htmlToPlain(text), keyboard, refs };
};

const renderAnswered = (form, note = 'Answered.') => {
  const lines = [
    `✅ <b>${escapeHtml(sessionTitle(form.sessionTitle, form.sessionId))}</b>`,
    `<b>${escapeHtml(form.title)}</b>`,
    '',
  ];
  for (const field of visibleFields(form)) {
    if (!isAnswered(field, form.answers)) continue;
    lines.push(`• <b>${escapeHtml(field.title)}</b>: ${escapeHtml(answerLabel(field, form.answers[field.key]))}`);
  }
  if (note) lines.push('', `<i>${escapeHtml(note)}</i>`);
  const text = clipHtmlSafe(lines.join('\n'));
  return { text, plain: htmlToPlain(text), keyboard: [] };
};

const renderDismissed = (form, note = 'Dismissed from Telegram.') => {
  const text = clipHtmlSafe([
    `✖ <b>${escapeHtml(sessionTitle(form.sessionTitle, form.sessionId))}</b>`,
    `<b>${escapeHtml(form.title)}</b>`,
    '',
    `<i>${escapeHtml(note)}</i>`,
  ].join('\n'));
  return { text, plain: htmlToPlain(text), keyboard: [] };
};

module.exports = {
  TYPES,
  sanitizeField,
  createFormState,
  formKey,
  visibleFields,
  findField,
  isAnswered,
  isComplete,
  nextTextField,
  applyChoice,
  applyText,
  answerLabel,
  answersForSubmit,
  renderForm,
  renderAnswered,
  renderDismissed,
  refFor,
};
