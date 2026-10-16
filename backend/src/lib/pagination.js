/**
 * Pagination parsing with a hard cap, and pagination metadata builder.
 *
 * Query parameters: `page` (default 1), `per_page` (default 20, max 100).
 */
import { validationError } from '../lib/ApiError.js';

export const PER_PAGE_DEFAULT = 20;
export const PER_PAGE_MAX = 100;

export function parsePagination(query, { defaultPerPage = PER_PAGE_DEFAULT, maxPerPage = PER_PAGE_MAX } = {}) {
  const details = [];

  let page = 1;
  if (query.page !== undefined) {
    const n = Number(query.page);
    if (!Number.isInteger(n) || n < 1) {
      details.push({ field: 'page', message: 'Must be an integer greater than or equal to 1.' });
    } else {
      page = Math.min(n, 1_000_000);
    }
  }

  let perPage = defaultPerPage;
  if (query.per_page !== undefined) {
    const n = Number(query.per_page);
    if (!Number.isInteger(n) || n < 1 || n > maxPerPage) {
      details.push({
        field: 'per_page',
        message: `Must be an integer between 1 and ${maxPerPage}.`,
      });
    } else {
      perPage = n;
    }
  }

  if (details.length > 0) throw validationError(details);

  return { page, perPage, limit: perPage, offset: (page - 1) * perPage };
}

export function buildPagination(page, perPage, total) {
  const totalPages = perPage > 0 ? Math.ceil(total / perPage) : 0;
  return {
    page,
    per_page: perPage,
    total,
    total_pages: totalPages,
    has_next: page < totalPages,
    has_prev: page > 1 && totalPages > 0,
  };
}
