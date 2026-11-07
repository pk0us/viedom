import { TestBed } from '@angular/core/testing';
import { Subject, of } from 'rxjs';
import type {
  ListingMarkersResponse,
  ListingSearchResponse,
  PublicListingCard
} from '@viedom/contracts';
import { SearchClient } from './search-client';
import { initialBounds } from './search-model';
import { SearchState } from './search-state';

const card = (id: string) => ({ id }) as PublicListingCard;

describe('public search request lifecycle', () => {
  let state: SearchState;
  let cards: Subject<ListingSearchResponse>[];
  let markers: Subject<ListingMarkersResponse>[];
  let client: { cards: ReturnType<typeof vi.fn>; markers: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.useFakeTimers();
    cards = [];
    markers = [];
    client = {
      cards: vi.fn(() => {
        const result = new Subject<ListingSearchResponse>();
        cards.push(result);
        return result;
      }),
      markers: vi.fn(() => {
        const result = new Subject<ListingMarkersResponse>();
        markers.push(result);
        return result;
      })
    };
    TestBed.configureTestingModule({
      providers: [SearchState, { provide: SearchClient, useValue: client }]
    });
    state = TestBed.inject(SearchState);
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
  });

  it('debounces movements and immediately unsubscribes old responses', () => {
    state.search(initialBounds());
    vi.advanceTimersByTime(200);
    state.search({ ...initialBounds(), transactionType: 'rent' });
    vi.advanceTimersByTime(300);
    expect(client.cards).toHaveBeenCalledTimes(1);
    state.search({ ...initialBounds(), transactionType: 'sale' });
    expect(cards[0]!.observed).toBe(false);
    expect(markers[0]!.observed).toBe(false);
    cards[0]!.next({ items: [card('old')], nextCursor: null });
    vi.advanceTimersByTime(300);
    cards[1]!.next({ items: [card('new')], nextCursor: 'page-2' });
    expect(state.cards().map((value) => value.id)).toEqual(['new']);
  });

  it('keeps card pagination independent of the marker cap and survives page errors', () => {
    state.search(initialBounds(), 0);
    vi.runOnlyPendingTimers();
    cards[0]!.next({ items: [card('first')], nextCursor: 'page-2' });
    markers[0]!.next({ items: [], capped: true, limit: 500 });
    state.loadMore();
    cards[1]!.error(new Error('network'));
    expect(state.cards()).toHaveLength(1);
    expect(state.pageError()).toBeTruthy();
    client.cards.mockReturnValueOnce(
      of({ items: [card('first'), card('second')], nextCursor: null })
    );
    state.loadMore();
    expect(state.cards().map((value) => value.id)).toEqual(['first', 'second']);
    expect(state.capped()).toBe(true);
    expect(client.markers).toHaveBeenCalledTimes(1);
  });

  it('retains successful cards on marker failure and cancels paging on area change', () => {
    state.search(initialBounds(), 0);
    vi.runOnlyPendingTimers();
    cards[0]!.next({ items: [card('first')], nextCursor: 'page-2' });
    markers[0]!.error(new Error('unavailable'));
    expect(state.cards()).toHaveLength(1);
    expect(state.markerError()).toBeTruthy();
    state.loadMore();
    state.search({ ...initialBounds(), minBedrooms: 2 });
    expect(cards[1]!.observed).toBe(false);
    expect(state.paging()).toBe(false);
    expect(state.cards()).toEqual([]);
  });

  it('does not request unsupported viewports and disposes pending work', () => {
    state.search({ west: -180, south: -90, east: 180, north: 90 }, 0);
    vi.runOnlyPendingTimers();
    expect(client.cards).not.toHaveBeenCalled();
    state.search(initialBounds());
    TestBed.resetTestingModule();
    vi.runOnlyPendingTimers();
    expect(client.cards).not.toHaveBeenCalled();
  });
});
