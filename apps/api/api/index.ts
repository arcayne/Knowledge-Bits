import { handle } from 'hono/vercel';

import { createRuntimeApp } from '../src/runtime.js';

export default handle(createRuntimeApp());
