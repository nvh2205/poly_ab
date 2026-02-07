import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';
import { Logger } from '@nestjs/common';

/**
 * Worker Entry Point
 * 
 * Starts the application in WORKER mode - only processes Bull queues.
 * Does NOT start HTTP server.
 * 
 * Usage:
 *   npm run start:worker
 *   node dist/worker.main.js
 */
async function bootstrapWorker() {
    const logger = new Logger('WorkerBootstrap');

    logger.log('🔧 Starting in WORKER mode...');

    // Create application without HTTP server
    const app = await NestFactory.createApplicationContext(WorkerModule);

    // Enable graceful shutdown
    app.enableShutdownHooks();

    logger.log('✅ Worker is running - processing queue jobs');
    logger.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    logger.log(`Redis: ${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || 6379}`);

    // Handle termination signals
    process.on('SIGTERM', async () => {
        logger.log('Received SIGTERM, shutting down gracefully...');
        await app.close();
        process.exit(0);
    });

    process.on('SIGINT', async () => {
        logger.log('Received SIGINT, shutting down gracefully...');
        await app.close();
        process.exit(0);
    });
}

bootstrapWorker();
