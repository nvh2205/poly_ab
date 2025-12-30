import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  // Setup Swagger
  const config = new DocumentBuilder()
    .setTitle('Polymarket Orderbook Data Collection System')
    .setDescription(
      'API documentation for Polymarket Orderbook Data Collection System. ' +
        'This system collects real-time market data from Polymarket via WebSocket connections.',
    )
    .setVersion('1.0.0')
    .addTag('market', 'Market discovery and management endpoints')
    .addTag('ingestion', 'Data ingestion and buffer management endpoints')
    .addTag('health', 'Health check endpoints')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, document, {
    swaggerOptions: {
      persistAuthorization: true,
      tagsSorter: 'alpha',
      operationsSorter: 'alpha',
    },
  });

  const port = process.env.PORT || 3000;
  await app.listen(port);

  logger.log(`Application is running on: http://localhost:${port}`);
  logger.log(`Swagger documentation: http://localhost:${port}/api`);
  logger.log(`Environment: ${process.env.NODE_ENV}`);
}

bootstrap();
