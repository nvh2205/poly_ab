import { Controller, Get, Param } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { EventCrawlerService } from './event.service';

@ApiTags('events')
@Controller('events')
export class EventController {
  constructor(private readonly eventCrawlerService: EventCrawlerService) {}

  @Get('slug/:slug')
  @ApiOperation({
    summary: 'Fetch an event by slug from Polymarket and persist it (also upserts markets)',
  })
  @ApiOkResponse({ description: 'Saved event entity' })
  async getEventBySlug(@Param('slug') slug: string) {
    return await this.eventCrawlerService.fetchAndSaveEventBySlug(slug);
  }
}


