'use strict';

const { createDeskService } = require('./app');
const { createLogger, safeError } = require('./lib/log');

const logger = createLogger({ level: process.env.TELEGRAM_DESK_LOG_LEVEL || 'info' });

const main = async () => {
  let service;
  try {
    service = createDeskService({ env: process.env, logger });
    const { port } = await service.start();
    logger.info('Telegram Desk started', { port });
  } catch (error) {
    logger.error('Telegram Desk could not start', safeError(error));
    process.exitCode = 1;
    return;
  }

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Telegram Desk stopping', { signal });
    const force = setTimeout(() => process.exit(0), 5000);
    force.unref?.();
    try {
      await service.stop();
    } catch (error) {
      logger.warn('Telegram Desk stop failed', safeError(error));
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection', safeError(reason));
  });
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', safeError(error));
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 1000).unref?.();
  });
};

void main();
