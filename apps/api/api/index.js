import { handle } from 'hono/vercel';

import { createRuntimeApp } from '../dist/runtime.js';

export default handle(createRuntimeApp());
