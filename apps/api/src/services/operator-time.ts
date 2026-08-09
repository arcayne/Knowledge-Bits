export const OPERATOR_TIME_ZONE = 'Europe/Madrid' as const;

const operatorDayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: OPERATOR_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function operatorDay(value: Date): string {
  const parts = new Map(
    operatorDayFormatter
      .formatToParts(value)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.get('year')}-${parts.get('month')}-${parts.get('day')}`;
}

export function isOnOperatorDay(value: Date | string, day: string): boolean {
  const date = value instanceof Date ? value : new Date(value);
  return !Number.isNaN(date.getTime()) && operatorDay(date) === day;
}
