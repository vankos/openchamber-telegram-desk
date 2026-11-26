'use strict';

const {
  renderForm,
  renderAnswered,
  renderDismissed,
  answersForSubmit,
  isComplete,
  visibleFields,
  applyChoice,
  applyText,
  nextTextField,
} = require('./forms');
const { HostError } = require('./host');
const { safeError } = require('./log');
const { formatError } = require('./format');

const createAnswerEngine = ({ store, host, telegram, logger, clock = Date.now }) => {
  const registerRefs = (refs) => {
    for (const { ref, payload } of refs) store.addRef(ref, payload);
  };

  const editForm = async (form, rendered) => {
    if (!form.messageId || !form.chatId) return;
    try {
      await telegram.editMessageText({
        chatId: form.chatId,
        messageId: form.messageId,
        text: rendered.text,
        plain: rendered.plain,
        keyboard: rendered.keyboard ?? [],
      });
    } catch (error) {
      logger?.debug('Could not edit a form card', { code: error?.code });
    }
  };

  const staleForm = async (form, note = 'This question is no longer open.') => {
    form.closed = true;
    form.updatedAt = clock();
    await editForm(form, renderDismissed(form, note));
    store.touch();
    return { ok: false, stale: true, error: note };
  };

  const submitForm = async (form, message = undefined) => {
    if (!form || form.closed) return { ok: false, stale: true, error: 'This question is already closed.' };
    if (form.submitting) return { ok: false, error: 'This answer is already being sent.' };
    if (!isComplete(form)) return { ok: false, error: 'Some required fields are still unanswered.' };
    form.submitting = true;
    try {
      await host.sessions.answerForm(form.sessionId, form.formId, answersForSubmit(form), message);
      form.closed = true;
      form.submitting = false;
      form.updatedAt = clock();
      store.bump('answers');
      store.touchSession(form.sessionId, { status: 'busy' });
      await editForm(form, renderAnswered(form, 'Answer sent to OpenChamber. The session continues.'));
      store.touch();
      return { ok: true };
    } catch (error) {
      form.submitting = false;
      if (error instanceof HostError && error.status === 404) {
        return staleForm(form, 'This question was already answered or closed in OpenChamber.');
      }
      logger?.warn('Could not answer a form', { code: error?.code, status: error?.status });
      return { ok: false, error: safeError(error).message ?? 'Could not reach OpenChamber.' };
    }
  };

  const dismissForm = async (form, reason = 'Dismissed from Telegram.') => {
    if (!form || form.closed) return { ok: false, stale: true, error: 'This question is already closed.' };
    if (form.submitting) return { ok: false, error: 'This answer is already being sent.' };
    form.submitting = true;
    try {
      await host.sessions.answerForm(form.sessionId, form.formId, null, reason);
      form.submitting = false;
      form.closed = true;
      form.updatedAt = clock();
      store.bump('answers');
      await editForm(form, renderDismissed(form, reason));
      store.touch();
      return { ok: true };
    } catch (error) {
      form.submitting = false;
      if (error instanceof HostError && error.status === 404) {
        return staleForm(form, 'This question was already dismissed or closed in OpenChamber.');
      }
      return { ok: false, error: safeError(error).message ?? 'Could not reach OpenChamber.' };
    }
  };

  const refreshForm = async (form) => {
    const rendered = renderForm(form);
    registerRefs(rendered.refs);
    await editForm(form, rendered);
    store.touch();
    return rendered;
  };

  const chooseOption = async (payload) => {
    const form = store.state.forms[`${payload.sessionId}:${payload.formId}`];
    if (!form || form.closed) return { ok: false, stale: true, error: 'This question is already closed.' };
    const outcome = applyChoice(form, payload.fieldKey, payload.value);
    if (!outcome.ok) {
      return { ok: false, error: outcome.error };
    }
    const fields = visibleFields(form);
    if (isComplete(form) && fields.length === 1 && fields[0].type !== 'multiselect') {
      return submitForm(form);
    }
    await refreshForm(form);
    return { ok: true, updated: true };
  };

  const answerWithText = async (form, text) => {
    if (!form || form.closed) return { ok: false, stale: true, error: 'This question is already closed.' };
    const field = nextTextField(form);
    if (!field) {
      const hasChoices = visibleFields(form).some((entry) => entry.options.length > 0 || entry.type === 'boolean');
      return {
        ok: false,
        error: hasChoices
          ? 'This question needs a button choice. Use the buttons on the question card.'
          : 'There is no text field waiting for an answer.',
      };
    }
    const outcome = applyText(form, field.key, text);
    if (!outcome.ok) return { ok: false, error: outcome.error };
    if (isComplete(form)) {
      return submitForm(form);
    }
    await refreshForm(form);
    return { ok: true, updated: true };
  };

  const answerPermission = async (permission, decision) => {
    if (!permission || permission.closed) {
      return { ok: false, stale: true, error: 'This permission request is already settled.' };
    }
    try {
      await host.sessions.answerPermission(permission.sessionId, permission.requestId, { decision });
      permission.closed = true;
      store.bump('answers');
      store.touchSession(permission.sessionId, { status: 'busy' });
      const note = decision === 'allow' ? 'Allowed once. The agent continues.' : 'Denied.';
      if (permission.messageId && permission.chatId) {
        const text = `🔐 <b>Permission request</b>\n<i>${note}</i>`;
        try {
          await telegram.editMessageText({
            chatId: permission.chatId,
            messageId: permission.messageId,
            text,
            plain: `Permission request\n${note}`,
            keyboard: [],
          });
        } catch (error) {
          logger?.debug('Could not edit a permission card', { code: error?.code });
        }
      }
      store.touch();
      return { ok: true };
    } catch (error) {
      if (error instanceof HostError && error.status === 404) {
        permission.closed = true;
        store.touch();
        const text = '🔐 <b>Permission request</b>\n<i>This request was already settled in OpenChamber.</i>';
        if (permission.messageId && permission.chatId) {
          try {
            await telegram.editMessageText({
              chatId: permission.chatId,
              messageId: permission.messageId,
              text,
              plain: 'Permission request\nThis request was already settled in OpenChamber.',
              keyboard: [],
            });
          } catch {
            // best effort
          }
        }
        return { ok: false, stale: true, error: 'This permission request was already settled.' };
      }
      logger?.warn('Could not answer a permission request', { code: error?.code, status: error?.status });
      return { ok: false, error: safeError(error).message ?? 'Could not reach OpenChamber.' };
    }
  };

  const errorReply = (message) => {
    const formatted = formatError(message);
    return { text: formatted.text, plain: formatted.plain };
  };

  return {
    submitForm,
    dismissForm,
    chooseOption,
    answerWithText,
    answerPermission,
    refreshForm,
    errorReply,
  };
};

module.exports = {
  createAnswerEngine,
};
