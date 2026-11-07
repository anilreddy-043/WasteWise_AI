export function visiblePageNumbers(
  currentPage: number,
  totalPages: number,
  maxButtons: number,
): number[] {
  const pageCount = Math.max(1, Math.floor(totalPages));
  const buttonCount = Math.max(1, Math.min(Math.floor(maxButtons), pageCount));
  const current = Math.min(Math.max(Math.floor(currentPage), 1), pageCount);
  const firstPage = Math.min(
    Math.max(current - Math.floor(buttonCount / 2), 1),
    pageCount - buttonCount + 1,
  );
  return Array.from({ length: buttonCount }, (_, index) => firstPage + index);
}
