import { defineMiddleware } from 'astro:middleware';

import {
  authenticateOperator,
  operatorErrorResponse,
} from './operator-auth.mjs';

export const onRequest = defineMiddleware(async (context, next) => {
  try {
    const principal = await authenticateOperator(context.request, import.meta.env);
    (context.locals as { reviewerId?: string }).reviewerId = principal.reviewerId;
    return next();
  } catch (error) {
    return operatorErrorResponse(error);
  }
});
