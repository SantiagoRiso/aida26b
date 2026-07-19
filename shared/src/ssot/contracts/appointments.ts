import type { Conflict } from '../domain/conflict';

export type RelatedClientIdsResult = { client_user_ids: number[] };
export type SeriesSkip = { date: string; conflicts: Conflict[] };
export type ScheduleSeriesResult<TSeries> = { series: TSeries; preview: { skipped: SeriesSkip[] } };
export type MaterializedOccurrenceResult<TAppointment> = { appointment: TAppointment };
export type SeriesResult<TSeries> = { series: TSeries };
export type SplitSeriesResult<TSeries> = { ended: TSeries; created: TSeries };
export type EndSeriesResult<TSeries> = { ended: TSeries; canceled: string[] };
