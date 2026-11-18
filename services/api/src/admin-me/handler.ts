import { createRouter, route } from '../lib/router';
import { jsonResponse } from '../lib/http';

const router = createRouter([
  route('GET', '/admin/me', ['owner', 'staff'], async ({ userId, roles }) =>
    jsonResponse(200, { userId, roles }),
  ),
]);

export const handler = router.handle;
