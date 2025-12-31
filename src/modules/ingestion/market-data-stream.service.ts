import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';
import { TopOfBookUpdate } from '../strategy/interfaces/top-of-book.interface';

@Injectable()
export class MarketDataStreamService implements OnModuleDestroy {
  private readonly topOfBookSubject = new Subject<TopOfBookUpdate>();

  emitTopOfBook(update: TopOfBookUpdate): void {
    this.topOfBookSubject.next(update);
  }

  onTopOfBook(): Observable<TopOfBookUpdate> {
    return this.topOfBookSubject.asObservable();
  }

  onModuleDestroy(): void {
    this.topOfBookSubject.complete();
  }
}

