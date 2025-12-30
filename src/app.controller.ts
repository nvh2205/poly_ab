import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiOkResponse } from '@nestjs/swagger';

@ApiTags('health')
@Controller()
export class AppController {
  @Get()
  @ApiOperation({ summary: 'Get API information' })
  @ApiOkResponse({
    description: 'API root endpoint with system information',
    schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          example: 'Polymarket Orderbook Data Collection System',
        },
        version: { type: 'string', example: '1.0.0' },
        status: { type: 'string', example: 'running' },
        endpoints: {
          type: 'object',
          properties: {
            health: { type: 'string', example: '/health' },
            market: { type: 'object' },
            ingestion: { type: 'object' },
          },
        },
      },
    },
  })
  getRoot() {
    return {
      name: 'Polymarket Orderbook Data Collection System',
      version: '1.0.0',
      status: 'running',
      endpoints: {
        health: '/health',
        market: {
          activeTokens: 'GET /market/active-tokens',
          triggerDiscovery: 'POST /market/trigger-discovery',
        },
        ingestion: {
          stats: 'GET /ingestion/stats',
          flush: 'POST /ingestion/flush',
        },
      },
    };
  }

  @Get('health')
  @ApiOperation({ summary: 'Health check endpoint' })
  @ApiOkResponse({
    description: 'System health status',
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', example: 'ok' },
        timestamp: { type: 'string', example: '2024-01-01T00:00:00.000Z' },
        uptime: { type: 'number', example: 3600 },
        memory: {
          type: 'object',
          properties: {
            rss: { type: 'number' },
            heapTotal: { type: 'number' },
            heapUsed: { type: 'number' },
            external: { type: 'number' },
          },
        },
      },
    },
  })
  getHealth() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
    };
  }
}
