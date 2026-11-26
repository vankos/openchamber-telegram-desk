'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createFormState,
  visibleFields,
  isComplete,
  applyChoice,
  applyText,
  answersForSubmit,
  renderForm,
  renderAnswered,
  nextTextField,
} = require('../service/lib/forms');

const formWith = (fields, title = 'Question') => createFormState(
  { sessionId: 'ses_1', sessionTitle: 'Fix parser', chatId: 5 },
  { id: 'frm_1', title, fields },
);

const choiceField = {
  key: 'choice',
  type: 'string',
  title: 'Choose one',
  required: true,
  options: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }],
};

test('renders a choice field as inline buttons with short callback data', () => {
  const form = formWith([choiceField]);
  const rendered = renderForm(form);
  const buttons = rendered.keyboard.flat();
  assert.equal(buttons.length, 3); // Alpha, Beta, Dismiss
  assert.equal(rendered.refs.length, 3);
  for (const row of rendered.keyboard) {
    for (const button of row) {
      assert.ok(Buffer.byteLength(button.callback_data) <= 64);
    }
  }
  assert.match(rendered.text, /Fix parser/);
  assert.match(rendered.text, /Choose one/);
});

test('single choice answers the form', () => {
  const form = formWith([choiceField]);
  const outcome = applyChoice(form, 'choice', 'a');
  assert.equal(outcome.ok, true);
  assert.equal(isComplete(form), true);
  assert.deepEqual(answersForSubmit(form), { choice: 'a' });
  const answered = renderAnswered(form);
  assert.match(answered.text, /Alpha/);
});

test('multiple fields need a submit only after every required answer', () => {
  const form = formWith([
    choiceField,
    { key: 'note', type: 'string', title: 'Note', required: true },
  ]);
  assert.equal(isComplete(form), false);
  applyChoice(form, 'choice', 'b');
  assert.equal(isComplete(form), false);
  const textField = nextTextField(form);
  assert.equal(textField.key, 'note');
  const outcome = applyText(form, 'note', 'hello');
  assert.equal(outcome.ok, true);
  assert.equal(isComplete(form), true);
  assert.deepEqual(answersForSubmit(form), { choice: 'b', note: 'hello' });
  const rendered = renderForm(form);
  assert.ok(rendered.keyboard.some((row) => row.some((button) => button.text.includes('Submit'))));
});

test('conditional fields become visible only when their conditions hold', () => {
  const form = formWith([
    {
      key: 'mode',
      type: 'string',
      title: 'Mode',
      required: true,
      options: [{ value: 'deep', label: 'Deep' }, { value: 'quick', label: 'Quick' }],
    },
    {
      key: 'deep_note',
      type: 'string',
      title: 'Deep note',
      required: true,
      when: [{ key: 'mode', op: 'eq', value: 'deep' }],
    },
  ]);
  assert.deepEqual(visibleFields(form).map((field) => field.key), ['mode']);
  assert.equal(isComplete(form), false);
  applyChoice(form, 'mode', 'deep');
  assert.deepEqual(visibleFields(form).map((field) => field.key), ['mode', 'deep_note']);
  assert.equal(isComplete(form), false);
  applyText(form, 'deep_note', 'details');
  assert.equal(isComplete(form), true);
  applyChoice(form, 'mode', 'quick');
  assert.deepEqual(visibleFields(form).map((field) => field.key), ['mode']);
  assert.deepEqual(answersForSubmit(form), { mode: 'quick' });
});

test('multiselect toggles values and requires a non-empty answer', () => {
  const form = formWith([{
    key: 'tags',
    type: 'multiselect',
    title: 'Tags',
    required: true,
    options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }],
  }]);
  applyChoice(form, 'tags', 'a');
  assert.equal(isComplete(form), true);
  applyChoice(form, 'tags', 'b');
  assert.deepEqual(answersForSubmit(form), { tags: ['a', 'b'] });
  applyChoice(form, 'tags', 'a');
  assert.deepEqual(answersForSubmit(form), { tags: ['b'] });
});

test('boolean, number and integer fields validate input', () => {
  const booleanForm = formWith([{ key: 'ok', type: 'boolean', title: 'OK?', required: true }]);
  assert.equal(applyText(booleanForm, 'ok', 'yes').ok, true);
  assert.equal(answersForSubmit(booleanForm).ok, true);

  const integerForm = formWith([{ key: 'count', type: 'integer', title: 'Count', required: true }]);
  assert.equal(applyText(integerForm, 'count', '3').ok, true);
  assert.equal(applyText(integerForm, 'count', '3.5').ok, false);
  assert.equal(applyText(integerForm, 'count', 'x').ok, false);

  const numberForm = formWith([{ key: 'ratio', type: 'number', title: 'Ratio', required: true }]);
  assert.equal(applyText(numberForm, 'ratio', '1.25').ok, true);
});

test('a string with options accepts a label but rejects an unknown value', () => {
  const form = formWith([choiceField]);
  assert.equal(applyText(form, 'choice', 'alpha').ok, true);
  assert.equal(form.answers.choice, 'a');
  assert.equal(applyText(form, 'choice', 'gamma').ok, false);
});

test('custom multiselect accepts comma-separated values', () => {
  const form = formWith([{
    key: 'labels',
    type: 'multiselect',
    title: 'Labels',
    required: true,
    custom: true,
    options: [{ value: 'a', label: 'A' }],
  }]);
  const outcome = applyText(form, 'labels', 'a, custom-value');
  assert.equal(outcome.ok, true);
  assert.deepEqual(answersForSubmit(form).labels, ['a', 'custom-value']);
});

test('a required external field blocks submit', () => {
  const form = formWith([{ key: 'link', type: 'external', title: 'Open the link', required: true }]);
  assert.equal(isComplete(form), false);
  const rendered = renderForm(form);
  assert.match(rendered.text, /Only in OpenChamber/);
  assert.ok(!rendered.keyboard.some((row) => row.some((button) => button.text.includes('Submit'))));
});

test('hidden fields do not leak into submitted values', () => {
  const form = formWith([
    { key: 'mode', type: 'string', title: 'Mode', required: true, options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
    { key: 'extra', type: 'string', title: 'Extra', required: false, when: [{ key: 'mode', op: 'eq', value: 'a' }] },
  ]);
  applyChoice(form, 'mode', 'a');
  applyText(form, 'extra', 'kept');
  applyChoice(form, 'mode', 'b');
  assert.deepEqual(answersForSubmit(form), { mode: 'b' });
});
