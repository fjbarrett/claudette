// Side-effect module: load .env into process.env as early as possible.
//
// Import this FIRST in every entry point (before any module that reads env at
// load time, e.g. config.js). ESM evaluates the first-imported module's
// top-level code before later imports run, so keys are in place in time.
import { loadEnv } from './env.js';

loadEnv();
