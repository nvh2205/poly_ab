import { Controller, Get, Post, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiOkResponse } from '@nestjs/swagger';
import { IngestionService } from './ingestion.service';

@ApiTags('ingestion')
@Controller('ingestion')
export class IngestionController {
  constructor(private readonly ingestionService: IngestionService) {}

  @Get('stats')
  @ApiOperation({ summary: 'Get ingestion statistics' })
  @ApiOkResponse({
    description:
      'Current ingestion statistics including buffer size and connection status',
    schema: {
      type: 'object',
      properties: {
        bufferSize: { type: 'number', example: 100 },
        connections: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              state: { type: 'string', example: 'OPEN' },
              tokens: { type: 'number', example: 50 },
              reconnectAttempts: { type: 'number', example: 0 },
            },
          },
        },
      },
    },
  })
  getStats() {
    return this.ingestionService.getStats();
  }

  @Post('flush')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Force flush buffer to database' })
  @ApiOkResponse({
    description: 'Buffer flushed successfully',
    schema: {
      type: 'object',
      properties: {
        message: { type: 'string', example: 'Buffer flushed successfully' },
      },
    },
  })
  async forceFlush() {
    await this.ingestionService.forceFlush();
    return {
      message: 'Buffer flushed successfully',
    };
  }
}
