import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Market } from './entities';

/**
 * Database Module
 * Centralized database entities and repository management
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Market,
      // Thêm entities khác ở đây
    ]),
  ],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}
