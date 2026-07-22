const localDateTime = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export function formatLocalDateTime(timestamp: number | null) {
  return timestamp === null ? "Unknown" : localDateTime.format(new Date(timestamp));
}
